//! Resolve a nested scenario tree into an ordered list of create operations.

use serde_json::Value;
use std::collections::{HashMap, HashSet};

use crate::template::resolve_template;
use crate::types::{CreateOp, DeferredUpdate, SchemaInfo, SchemaRelation};

const RESERVED_KEYS: &[&str] = &["_alias", "_ref", "_count", "_batch"];

pub struct ResolvedTree {
    pub ops: Vec<CreateOp>,
    pub deferred_updates: Vec<DeferredUpdate>,
    pub aliases: HashMap<String, String>,
}

impl ResolvedTree {
    fn new() -> Self {
        Self {
            ops: Vec::new(),
            deferred_updates: Vec::new(),
            aliases: HashMap::new(),
        }
    }
}

pub fn resolve_tree(
    create: &Value,
    schema: &SchemaInfo,
    test_run_id: &str,
) -> ResolvedTree {
    let create_obj = match create.as_object() {
        Some(obj) => obj,
        None => return ResolvedTree::new(),
    };

    // Build relation lookups
    let mut relation_by_parent_field: HashMap<String, &SchemaRelation> = HashMap::new();
    for rel in &schema.relations {
        let key = format!("{}.{}", rel.parent_model, rel.parent_field);
        relation_by_parent_field.insert(key, rel);
    }

    // Determine FK direction
    let mut fk_on_parent: HashSet<String> = HashSet::new();
    for rel in &schema.relations {
        for edge in &schema.edges {
            if edge.local_field == rel.child_field
                && (edge.from_model == rel.parent_model || edge.from_model == rel.child_model)
            {
                if edge.from_model == rel.parent_model {
                    fk_on_parent.insert(format!("{}.{}", rel.parent_model, rel.parent_field));
                }
                break;
            }
        }
    }

    let mut result = ResolvedTree::new();
    let mut temp_counter: usize = 0;

    for (model_name, nodes_val) in create_obj {
        if let Some(nodes) = nodes_val.as_array() {
            for (i, node) in nodes.iter().enumerate() {
                walk_node(
                    model_name,
                    node,
                    None,
                    None,
                    false,
                    i,
                    test_run_id,
                    &relation_by_parent_field,
                    &fk_on_parent,
                    &schema,
                    &mut result,
                    &mut temp_counter,
                );
            }
        }
    }

    result
}

#[allow(clippy::too_many_arguments)]
fn walk_node(
    model_name: &str,
    node: &Value,
    parent_temp_id: Option<&str>,
    parent_relation: Option<&SchemaRelation>,
    parent_fk_on_parent: bool,
    index: usize,
    test_run_id: &str,
    relation_by_parent_field: &HashMap<String, &SchemaRelation>,
    fk_on_parent: &HashSet<String>,
    schema: &SchemaInfo,
    result: &mut ResolvedTree,
    temp_counter: &mut usize,
) -> String {
    let node_obj = match node.as_object() {
        Some(obj) => obj,
        None => {
            let temp_id = make_temp_id(model_name, temp_counter);
            result.ops.push(CreateOp {
                model: model_name.to_string(),
                fields: HashMap::new(),
                temp_id: temp_id.clone(),
                batch: false,
            });
            return temp_id;
        }
    };

    let mut fields: HashMap<String, Value> = HashMap::new();
    let mut pre_children: Vec<(&SchemaRelation, &Value, bool)> = Vec::new();
    let mut post_children: Vec<(&SchemaRelation, &Value, bool)> = Vec::new();
    let alias = node_obj.get("_alias").and_then(|v| v.as_str()).map(String::from);
    let temp_id = make_temp_id(model_name, temp_counter);

    let reserved: HashSet<&str> = RESERVED_KEYS.iter().copied().collect();

    for (key, value) in node_obj {
        if reserved.contains(key.as_str()) {
            continue;
        }

        // Look up relation
        let exact_key = format!("{}.{}", model_name, key);
        let lm = lower_first(model_name);
        let prefixed_key = format!(
            "{}.{}{}{}",
            model_name,
            lm,
            key.chars().next().unwrap_or_default().to_uppercase(),
            &key[key.chars().next().map(|c| c.len_utf8()).unwrap_or(0)..]
        );

        let relation = relation_by_parent_field
            .get(&exact_key)
            .or_else(|| relation_by_parent_field.get(&prefixed_key))
            .copied();

        let matched_key = if relation_by_parent_field.contains_key(&exact_key) {
            &exact_key
        } else {
            &prefixed_key
        };

        // Fallback: match by child model name
        let relation = relation.or_else(|| {
            for (rel_key, rel) in relation_by_parent_field {
                if rel_key.starts_with(&format!("{}.", model_name))
                    && rel.child_model.to_lowercase() == key.to_lowercase()
                {
                    return Some(*rel);
                }
            }
            None
        });

        if let Some(rel) = relation {
            let is_on_parent = fk_on_parent.contains(matched_key);
            if is_on_parent {
                pre_children.push((rel, value, true));
            } else {
                post_children.push((rel, value, false));
            }
            continue;
        }

        // Handle _ref
        if let Some(obj) = value.as_object() {
            if let Some(ref_alias) = obj.get("_ref").and_then(|v| v.as_str()) {
                if let Some(ref_temp_id) = result.aliases.get(ref_alias) {
                    fields.insert(key.clone(), Value::String(ref_temp_id.clone()));
                } else {
                    result.deferred_updates.push(DeferredUpdate {
                        target_temp_id: temp_id.clone(),
                        model: model_name.to_string(),
                        field: key.clone(),
                        ref_alias: ref_alias.to_string(),
                    });
                }
                continue;
            }
        }

        let ctx = serde_json::json!({"testRunId": test_run_id, "index": index});
        fields.insert(key.clone(), resolve_template(value, &ctx));
    }

    // Wire FK to parent
    if let Some(parent_rel) = parent_relation {
        if let Some(ptid) = parent_temp_id {
            if !parent_fk_on_parent {
                fields.insert(
                    parent_rel.child_field.clone(),
                    Value::String(ptid.to_string()),
                );
            }
        }
    }

    // Process pre-children
    for (relation, value, _is_on_parent) in &pre_children {
        if let Some(arr) = value.as_array() {
            for (i, child_node) in arr.iter().enumerate() {
                let child_temp_id = walk_node(
                    &relation.child_model,
                    child_node,
                    Some(&temp_id),
                    Some(relation),
                    true,
                    i,
                    test_run_id,
                    relation_by_parent_field,
                    fk_on_parent,
                    schema,
                    result,
                    temp_counter,
                );
                fields.insert(
                    relation.child_field.clone(),
                    Value::String(child_temp_id),
                );
            }
        }
    }

    // Create this node
    result.ops.push(CreateOp {
        model: model_name.to_string(),
        fields,
        temp_id: temp_id.clone(),
        batch: false,
    });
    if let Some(a) = &alias {
        result.aliases.insert(a.clone(), temp_id.clone());
    }

    // Process post-children
    for (relation, value, _) in &post_children {
        if let Some(arr) = value.as_array() {
            for (i, child_node) in arr.iter().enumerate() {
                walk_node(
                    &relation.child_model,
                    child_node,
                    Some(&temp_id),
                    Some(relation),
                    false,
                    i,
                    test_run_id,
                    relation_by_parent_field,
                    fk_on_parent,
                    schema,
                    result,
                    temp_counter,
                );
            }
        } else if let Some(obj) = value.as_object() {
            if let Some(count) = obj.get("_count").and_then(|v| v.as_u64()) {
                let is_batch = obj
                    .get("_batch")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                for i in 0..count as usize {
                    let mut bulk_fields: HashMap<String, Value> = HashMap::new();
                    for (k, v) in obj {
                        if k == "_count" || k == "_batch" {
                            continue;
                        }
                        let ctx =
                            serde_json::json!({"testRunId": test_run_id, "index": i});
                        bulk_fields.insert(k.clone(), resolve_template(v, &ctx));
                    }
                    bulk_fields.insert(
                        relation.child_field.clone(),
                        Value::String(temp_id.clone()),
                    );
                    let child_temp_id = make_temp_id(&relation.child_model, temp_counter);
                    result.ops.push(CreateOp {
                        model: relation.child_model.clone(),
                        fields: bulk_fields,
                        temp_id: child_temp_id,
                        batch: is_batch,
                    });
                }
            }
        }
    }

    temp_id
}

fn make_temp_id(model: &str, counter: &mut usize) -> String {
    let id = format!("__temp_{}_{}", model, counter);
    *counter += 1;
    id
}

fn lower_first(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    let mut chars = s.chars();
    chars
        .next()
        .unwrap()
        .to_lowercase()
        .collect::<String>()
        + chars.as_str()
}
