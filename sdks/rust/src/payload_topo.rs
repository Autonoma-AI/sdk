//! Resolve the create payload into an ordered list of operations.
//!
//! The SDK no longer derives ordering from a static FK schema. Instead, the
//! create payload itself contains complete dependency information via
//! `_alias` / `_ref` markers. This module walks those markers, builds a
//! dependency graph, and produces a topologically sorted list of `CreateOp`
//! items via Kahn's algorithm.

use std::collections::HashMap;

use serde_json::Value;

use crate::errors::invalid_body;
use crate::errors::AutonomaError;
use crate::types::{CreateOp, ResolvedTree};

const RESERVED_KEYS: &[&str] = &["_alias", "_ref"];

// ---------------------------------------------------------------------------
// Walking the payload
// ---------------------------------------------------------------------------

/// Walk a field value tree and append every `_ref` alias found.
fn collect_refs(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(r)) = map.get("_ref") {
                out.push(r.clone());
                return;
            }
            for v in map.values() {
                collect_refs(v, out);
            }
        }
        Value::Array(arr) => {
            for v in arr {
                collect_refs(v, out);
            }
        }
        _ => {}
    }
}

/// Replace each `{"_ref": alias}` with its temp id.
fn resolve_refs(value: &Value, alias_to_temp_id: &HashMap<String, String>) -> Value {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(r)) = map.get("_ref") {
                if let Some(real) = alias_to_temp_id.get(r) {
                    return Value::String(real.clone());
                }
                return value.clone();
            }
            let resolved: serde_json::Map<String, Value> = map
                .iter()
                .map(|(k, v)| (k.clone(), resolve_refs(v, alias_to_temp_id)))
                .collect();
            Value::Object(resolved)
        }
        Value::Array(arr) => {
            Value::Array(arr.iter().map(|v| resolve_refs(v, alias_to_temp_id)).collect())
        }
        _ => value.clone(),
    }
}

// ---------------------------------------------------------------------------
// Tree resolution
// ---------------------------------------------------------------------------

/// Topo-sort a create payload into an ordered list of `CreateOp`.
///
/// `create` is the dashboard's nested map `{model: [entity, ...]}`.
/// Each entity is an object; `_alias` (declared by dependency targets)
/// and `_ref` (declared by dependents, anywhere in the field tree) are
/// the only reserved keys.
///
/// Returns `Err(INVALID_BODY)` if the payload references an alias that
/// is never declared, or if the alias graph contains a cycle.
pub fn resolve_payload_tree(
    create: &serde_json::Map<String, Value>,
) -> Result<ResolvedTree, AutonomaError> {
    // First pass: assign temp ids and collect alias declarations.
    #[allow(dead_code)]
    struct RawEntry {
        model: String,
        temp_id: String,
        entity: serde_json::Map<String, Value>,
        alias: Option<String>,
    }

    let mut raw_entries: Vec<RawEntry> = Vec::new();
    let mut counter: usize = 0;
    let mut aliases: HashMap<String, String> = HashMap::new();
    let mut alias_owner_model: HashMap<String, String> = HashMap::new();

    for (model, entities_val) in create {
        let entities = entities_val
            .as_array()
            .ok_or_else(|| {
                invalid_body(&format!(
                    "`create.{}` must be a list of entity objects",
                    model
                ))
            })?;

        for entity_val in entities {
            let entity = entity_val
                .as_object()
                .ok_or_else(|| {
                    invalid_body(&format!(
                        "`create.{}` entries must be objects",
                        model
                    ))
                })?;

            let temp_id = format!("__temp_{}_{}", model, counter);
            counter += 1;

            let alias = match entity.get("_alias") {
                Some(Value::String(a)) => {
                    if aliases.contains_key(a) {
                        return Err(invalid_body(&format!("duplicate _alias \"{}\"", a)));
                    }
                    aliases.insert(a.clone(), temp_id.clone());
                    alias_owner_model.insert(a.clone(), model.clone());
                    Some(a.clone())
                }
                Some(Value::Null) | None => None,
                _ => return Err(invalid_body("\"_alias\" must be a string")),
            };

            raw_entries.push(RawEntry {
                model: model.clone(),
                temp_id,
                entity: entity.clone(),
                alias,
            });
        }
    }

    // Second pass: collect each entry's dependency aliases and strip reserved keys.
    let mut deps_by_temp_id: HashMap<String, Vec<String>> = HashMap::new();
    let mut fields_by_temp_id: HashMap<String, serde_json::Map<String, Value>> = HashMap::new();
    let mut model_by_temp_id: HashMap<String, String> = HashMap::new();

    for entry in &raw_entries {
        let mut deps: Vec<String> = Vec::new();
        let mut cleaned: serde_json::Map<String, Value> = serde_json::Map::new();

        for (key, value) in &entry.entity {
            if RESERVED_KEYS.contains(&key.as_str()) {
                continue;
            }
            collect_refs(value, &mut deps);
            cleaned.insert(key.clone(), resolve_refs(value, &aliases));
        }

        let unknown: Vec<&String> = deps.iter().filter(|a| !aliases.contains_key(*a)).collect();
        if !unknown.is_empty() {
            let mut unique: Vec<String> = unknown.into_iter().cloned().collect();
            unique.sort();
            unique.dedup();
            return Err(invalid_body(&format!(
                "`create.{}` references unknown alias(es): {}",
                entry.model,
                unique.join(", ")
            )));
        }

        deps_by_temp_id.insert(entry.temp_id.clone(), deps);
        fields_by_temp_id.insert(entry.temp_id.clone(), cleaned);
        model_by_temp_id.insert(entry.temp_id.clone(), entry.model.clone());
    }

    // Build the temp_id graph and topo-sort.
    let mut in_degree: HashMap<String, usize> = HashMap::new();
    let mut edges: HashMap<String, Vec<String>> = HashMap::new();

    for entry in &raw_entries {
        in_degree.insert(entry.temp_id.clone(), 0);
    }

    for (temp_id, deps) in &deps_by_temp_id {
        let mut seen = std::collections::HashSet::new();
        for dep_alias in deps {
            let dep_temp_id = &aliases[dep_alias];
            if dep_temp_id == temp_id || !seen.insert(dep_temp_id.clone()) {
                continue;
            }
            edges
                .entry(dep_temp_id.clone())
                .or_default()
                .push(temp_id.clone());
            *in_degree.entry(temp_id.clone()).or_insert(0) += 1;
        }
    }

    // Kahn's, preserving payload order as stable tie-breaker.
    let payload_order: HashMap<String, usize> = raw_entries
        .iter()
        .enumerate()
        .map(|(idx, e)| (e.temp_id.clone(), idx))
        .collect();

    let mut ready: Vec<String> = in_degree
        .iter()
        .filter(|(_, &deg)| deg == 0)
        .map(|(tid, _)| tid.clone())
        .collect();
    ready.sort_by_key(|t| payload_order[t]);

    let mut sorted_temp_ids: Vec<String> = Vec::new();

    while let Some(tid) = ready.first().cloned() {
        ready.remove(0);
        sorted_temp_ids.push(tid.clone());
        if let Some(neighbors) = edges.get(&tid) {
            for nxt in neighbors {
                if let Some(deg) = in_degree.get_mut(nxt) {
                    *deg -= 1;
                    if *deg == 0 {
                        ready.push(nxt.clone());
                    }
                }
            }
        }
        ready.sort_by_key(|t| payload_order[t]);
    }

    if sorted_temp_ids.len() != payload_order.len() {
        let cycle: Vec<String> = in_degree
            .iter()
            .filter(|(_, &deg)| deg > 0)
            .map(|(tid, _)| tid.clone())
            .collect();
        let mut cycle_sorted = cycle;
        cycle_sorted.sort_by_key(|t| payload_order.get(t).copied().unwrap_or(usize::MAX));
        let cycle_models: Vec<String> = cycle_sorted
            .iter()
            .map(|t| model_by_temp_id[t].clone())
            .collect();
        return Err(invalid_body(&format!(
            "cycle detected in _alias/_ref graph: {}",
            cycle_models.join(", ")
        )));
    }

    // Build CreateOp list in topo order.
    let alias_dependencies: HashMap<String, Vec<String>> = aliases
        .iter()
        .map(|(alias, tid)| {
            let deps = deps_by_temp_id.get(tid).cloned().unwrap_or_default();
            (alias.clone(), deps)
        })
        .collect();

    let ops: Vec<CreateOp> = sorted_temp_ids
        .iter()
        .map(|tid| CreateOp {
            model: model_by_temp_id[tid].clone(),
            fields: fields_by_temp_id.remove(tid).unwrap_or_default(),
            temp_id: tid.clone(),
        })
        .collect();

    Ok(ResolvedTree {
        ops,
        aliases,
        alias_owner_model,
        alias_dependencies,
    })
}

// ---------------------------------------------------------------------------
// Teardown ordering
// ---------------------------------------------------------------------------

/// Order models for teardown.
///
/// With `alias_dependencies` available (newer refs tokens carry it),
/// we run Kahn's topo sort over models and return the *reverse* topo
/// so children are torn down before parents.
///
/// Without it (older refs tokens), fall back to reversing the insertion
/// order of `refs` keys.
pub fn compute_teardown_order(
    refs: &HashMap<String, Vec<serde_json::Map<String, Value>>>,
    alias_dependencies: Option<&HashMap<String, Vec<String>>>,
    alias_owner_model: Option<&HashMap<String, String>>,
) -> Vec<String> {
    let models: Vec<String> = refs.keys().cloned().collect();

    let (alias_deps, alias_owners) = match (alias_dependencies, alias_owner_model) {
        (Some(ad), Some(ao)) if !ad.is_empty() => (ad, ao),
        _ => {
            let mut reversed = models;
            reversed.reverse();
            return reversed;
        }
    };

    // Build model -> {model dependencies} by aggregating per-alias edges.
    let mut model_deps: HashMap<String, std::collections::HashSet<String>> = HashMap::new();
    for m in &models {
        model_deps.insert(m.clone(), std::collections::HashSet::new());
    }

    for (alias, deps) in alias_deps {
        let owner = match alias_owners.get(alias) {
            Some(o) if model_deps.contains_key(o) => o,
            _ => continue,
        };
        for dep_alias in deps {
            if let Some(dep_model) = alias_owners.get(dep_alias) {
                if dep_model != owner && model_deps.contains_key(dep_model) {
                    model_deps
                        .get_mut(owner)
                        .unwrap()
                        .insert(dep_model.clone());
                }
            }
        }
    }

    // Kahn's over models.
    let mut in_degree: HashMap<String, usize> = HashMap::new();
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    for m in &models {
        in_degree.insert(m.clone(), 0);
    }
    for (owner, deps) in &model_deps {
        for dep_model in deps {
            adj.entry(dep_model.clone())
                .or_default()
                .push(owner.clone());
            *in_degree.entry(owner.clone()).or_insert(0) += 1;
        }
    }

    let payload_order: HashMap<String, usize> = models
        .iter()
        .enumerate()
        .map(|(i, m)| (m.clone(), i))
        .collect();

    let mut ready: Vec<String> = in_degree
        .iter()
        .filter(|(_, &d)| d == 0)
        .map(|(m, _)| m.clone())
        .collect();
    ready.sort_by_key(|m| payload_order.get(m).copied().unwrap_or(usize::MAX));

    let mut up_order: Vec<String> = Vec::new();
    while let Some(m) = ready.first().cloned() {
        ready.remove(0);
        up_order.push(m.clone());
        if let Some(neighbors) = adj.get(&m) {
            for nxt in neighbors {
                if let Some(deg) = in_degree.get_mut(nxt) {
                    *deg -= 1;
                    if *deg == 0 {
                        ready.push(nxt.clone());
                    }
                }
            }
        }
        ready.sort_by_key(|m| payload_order.get(m).copied().unwrap_or(usize::MAX));
    }

    if up_order.len() != models.len() {
        // Shouldn't happen — cycles are rejected at `up`. Fall back.
        let mut reversed = models;
        reversed.reverse();
        return reversed;
    }

    up_order.reverse();
    up_order
}
