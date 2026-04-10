//! Tear down scoped test data via raw SQL DELETE in reverse topological order.

use serde_json::Value;
use std::collections::{HashMap, HashSet};

use crate::dialect::Dialect;
use crate::graph::{find_deferrable_edge, topo_sort};
use crate::types::{SchemaInfo, SqlExecutor};

pub async fn teardown(
    executor: &dyn SqlExecutor,
    dialect: &dyn Dialect,
    table_map: &HashMap<String, String>,
    column_maps: &HashMap<String, HashMap<String, String>>,
    schema: &SchemaInfo,
    scope_value: &str,
    refs: Option<&Value>,
) -> Result<(), String> {
    // Convert edges to Value format for graph module
    let edge_dicts: Vec<Value> = schema
        .edges
        .iter()
        .map(|e| {
            serde_json::json!({
                "from": e.from_model,
                "to": e.to_model,
                "localField": e.local_field,
                "foreignField": e.foreign_field,
                "nullable": e.nullable
            })
        })
        .collect();

    // Find scope root model
    let scope_root_model: Option<String> = schema.edges.iter().find_map(|edge| {
        if edge.local_field.to_lowercase() == schema.scope_field.to_lowercase()
            && edge.to_model != edge.from_model
        {
            Some(edge.to_model.clone())
        } else {
            None
        }
    });

    // Build map: model -> FK field pointing to scope root
    let mut scope_field_by_model: HashMap<String, String> = HashMap::new();
    if let Some(ref root) = scope_root_model {
        for edge in &schema.edges {
            if edge.to_model == *root && edge.from_model != *root {
                scope_field_by_model.insert(edge.from_model.clone(), edge.local_field.clone());
            }
        }
    }

    let model_names: Vec<String> = schema.models.iter().map(|m| m.name.clone()).collect();
    let sort_result = topo_sort(&model_names, &edge_dicts);
    let sorted_models: Vec<String> = sort_result
        .get("sorted")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let cycles: Vec<Vec<String>> = sort_result
        .get("cycles")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    v.as_array().map(|cycle| {
                        cycle
                            .iter()
                            .filter_map(|n| n.as_str().map(String::from))
                            .collect()
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    // Transaction wrapper — use the executor's transaction method
    // Break cycles by nullifying deferrable FKs
    for cycle in &cycles {
        let cycle_strs: Vec<String> = cycle.clone();
        let edge = find_deferrable_edge(&cycle_strs, &edge_dicts);
        if let Some(edge_obj) = edge.as_object() {
            let from = edge_obj
                .get("from")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let local_field = edge_obj
                .get("localField")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if let Some(scope_fk) = scope_field_by_model.get(from) {
                if let Some(db_table) = table_map.get(from) {
                    let col_map = column_maps.get(from).cloned().unwrap_or_default();
                    let db_fk_col = col_map
                        .get(local_field)
                        .cloned()
                        .unwrap_or_else(|| local_field.to_string());
                    let db_scope_col = col_map
                        .get(scope_fk)
                        .cloned()
                        .unwrap_or_else(|| scope_fk.clone());
                    let sql = format!(
                        "UPDATE {} SET {} = NULL WHERE {} = {}",
                        dialect.quote_id(db_table),
                        dialect.quote_id(&db_fk_col),
                        dialect.quote_id(&db_scope_col),
                        dialect.param(1)
                    );
                    executor
                        .query(&sql, Some(&[Value::String(scope_value.to_string())]))
                        .await?;
                }
            }
        }
    }

    // Partition sorted nodes: those that depend on cycle nodes must be deleted
    // BEFORE cycles, those that cycle nodes depend on must be deleted AFTER.
    let cycle_node_set: HashSet<&str> = cycles.iter().flatten().map(|s| s.as_str()).collect();

    if !cycle_node_set.is_empty() {
        // Build dependency map: node → set of nodes it depends on
        let mut depends_on: HashMap<&str, HashSet<&str>> = HashMap::new();
        for edge in &schema.edges {
            if edge.from_model != edge.to_model {
                depends_on.entry(edge.from_model.as_str()).or_default().insert(edge.to_model.as_str());
            }
        }

        // Mark nodes that transitively depend on cycle nodes
        let mut depends_on_cycle: HashSet<&str> = HashSet::new();
        for node in &sorted_models {
            if let Some(deps) = depends_on.get(node.as_str()) {
                for dep in deps {
                    if cycle_node_set.contains(dep) || depends_on_cycle.contains(dep) {
                        depends_on_cycle.insert(node.as_str());
                        break;
                    }
                }
            }
        }

        let cycle_dependents: Vec<&str> = sorted_models.iter()
            .filter(|n| depends_on_cycle.contains(n.as_str()))
            .map(|s| s.as_str()).collect();
        let cycle_deps: Vec<&str> = sorted_models.iter()
            .filter(|n| !depends_on_cycle.contains(n.as_str()))
            .map(|s| s.as_str()).collect();

        for model in cycle_dependents.iter().rev() {
            if scope_root_model.as_deref() == Some(*model) {
                continue;
            }
            delete_model(executor, dialect, table_map, column_maps, model,
                scope_value, &scope_field_by_model, refs, schema).await?;
        }

        for cycle in &cycles {
            for model in cycle {
                delete_model(executor, dialect, table_map, column_maps, model,
                    scope_value, &scope_field_by_model, refs, schema).await?;
            }
        }

        for model in cycle_deps.iter().rev() {
            if scope_root_model.as_deref() == Some(*model) {
                continue;
            }
            delete_model(executor, dialect, table_map, column_maps, model,
                scope_value, &scope_field_by_model, refs, schema).await?;
        }
    } else {
        for model in sorted_models.iter().rev() {
            if scope_root_model.as_deref() == Some(model.as_str()) {
                continue;
            }
            delete_model(executor, dialect, table_map, column_maps, model,
                scope_value, &scope_field_by_model, refs, schema).await?;
        }
    }

    // Delete scope root last
    if let Some(ref root) = scope_root_model {
        if let Some(db_table) = table_map.get(root) {
            let col_map = column_maps.get(root).cloned().unwrap_or_default();
            // Bug 4: use dynamic PK field from schema (composite PK: prefer "id")
            let root_model_info = schema.models.iter().find(|m| m.name == *root);
            let root_id_fields: Vec<&crate::types::FieldInfo> = root_model_info
                .map(|mi| mi.fields.iter().filter(|f| f.is_id).collect())
                .unwrap_or_default();
            let root_pk_field_name = root_id_fields.iter()
                .find(|f| f.name.eq_ignore_ascii_case("id"))
                .or(root_id_fields.first())
                .map(|f| f.name.as_str())
                .unwrap_or("id");
            let id_col = col_map
                .get(root_pk_field_name)
                .cloned()
                .unwrap_or_else(|| root_pk_field_name.to_string());
            let sql = format!(
                "DELETE FROM {} WHERE {} = {}",
                dialect.quote_id(db_table),
                dialect.quote_id(&id_col),
                dialect.param(1)
            );
            executor
                .query(&sql, Some(&[Value::String(scope_value.to_string())]))
                .await?;
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn delete_model(
    executor: &dyn SqlExecutor,
    dialect: &dyn Dialect,
    table_map: &HashMap<String, String>,
    column_maps: &HashMap<String, HashMap<String, String>>,
    model: &str,
    scope_value: &str,
    scope_field_by_model: &HashMap<String, String>,
    refs: Option<&Value>,
    schema: &SchemaInfo,
) -> Result<(), String> {
    let db_table = match table_map.get(model) {
        Some(t) => t,
        None => return Ok(()),
    };
    let col_map = column_maps.get(model).cloned().unwrap_or_default();

    // Bug 4: Find actual PK field name from schema
    // When multiple is_id fields exist (composite PK), prefer the one named "id"
    let model_info = schema.models.iter().find(|m| m.name == model);
    let id_fields: Vec<&crate::types::FieldInfo> = model_info
        .map(|mi| mi.fields.iter().filter(|f| f.is_id).collect())
        .unwrap_or_default();
    let pk_field_name = id_fields.iter()
        .find(|f| f.name.eq_ignore_ascii_case("id"))
        .or(id_fields.first())
        .map(|f| f.name.as_str())
        .unwrap_or("id");

    if let Some(scope_fk) = scope_field_by_model.get(model) {
        let db_col = col_map
            .get(scope_fk)
            .cloned()
            .unwrap_or_else(|| scope_fk.clone());
        let sql = format!(
            "DELETE FROM {} WHERE {} = {}",
            dialect.quote_id(db_table),
            dialect.quote_id(&db_col),
            dialect.param(1)
        );
        executor
            .query(&sql, Some(&[Value::String(scope_value.to_string())]))
            .await?;
    } else if let Some(ref_records) = refs.and_then(|r| r.get(model)).and_then(|v| v.as_array()) {
        // Bug 3: Accept any non-null value for IDs (not just strings)
        let ids: Vec<Value> = ref_records
            .iter()
            .filter_map(|r| r.get(pk_field_name))
            .filter(|v| !v.is_null())
            .cloned()
            .collect();
        if !ids.is_empty() {
            let id_col = col_map
                .get(pk_field_name)
                .cloned()
                .unwrap_or_else(|| pk_field_name.to_string());
            let placeholders: Vec<String> =
                (0..ids.len()).map(|i| dialect.param(i + 1)).collect();
            let sql = format!(
                "DELETE FROM {} WHERE {} IN ({})",
                dialect.quote_id(db_table),
                dialect.quote_id(&id_col),
                placeholders.join(", ")
            );
            executor.query(&sql, Some(&ids)).await?;
        }
    }

    Ok(())
}
