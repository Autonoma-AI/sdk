//! Tear down scoped test data via raw SQL DELETE in reverse topological order.

use serde_json::Value;
use std::collections::HashMap;

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

    // Delete cycle nodes
    for cycle in &cycles {
        for model in cycle {
            delete_model(
                executor,
                dialect,
                table_map,
                column_maps,
                model,
                scope_value,
                &scope_field_by_model,
                refs,
            )
            .await?;
        }
    }

    // Delete in reverse topo order
    for model in sorted_models.iter().rev() {
        if scope_root_model.as_deref() == Some(model.as_str()) {
            continue;
        }
        delete_model(
            executor,
            dialect,
            table_map,
            column_maps,
            model,
            scope_value,
            &scope_field_by_model,
            refs,
        )
        .await?;
    }

    // Delete scope root last
    if let Some(ref root) = scope_root_model {
        if let Some(db_table) = table_map.get(root) {
            let col_map = column_maps.get(root).cloned().unwrap_or_default();
            let id_col = col_map
                .get("id")
                .cloned()
                .unwrap_or_else(|| "id".to_string());
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
) -> Result<(), String> {
    let db_table = match table_map.get(model) {
        Some(t) => t,
        None => return Ok(()),
    };
    let col_map = column_maps.get(model).cloned().unwrap_or_default();

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
        let ids: Vec<Value> = ref_records
            .iter()
            .filter_map(|r| r.get("id"))
            .filter(|v| v.is_string())
            .cloned()
            .collect();
        if !ids.is_empty() {
            let id_col = col_map
                .get("id")
                .cloned()
                .unwrap_or_else(|| "id".to_string());
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
