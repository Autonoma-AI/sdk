//! Create entities via raw SQL INSERT.

use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::sync::LazyLock;
use uuid::Uuid;

static MYSQL_DATETIME_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}").unwrap()
});

use crate::dialect::Dialect;
use crate::types::{ModelInfo, SqlExecutor};

pub async fn create_entities(
    executor: &dyn SqlExecutor,
    dialect: &dyn Dialect,
    table_map: &HashMap<String, String>,
    column_maps: &HashMap<String, HashMap<String, String>>,
    spec: &HashMap<String, Value>,
    enum_type_maps: &HashMap<String, HashMap<String, String>>,
    schema_models: &[ModelInfo],
) -> Result<HashMap<String, Vec<HashMap<String, Value>>>, String> {
    let mut results: HashMap<String, Vec<HashMap<String, Value>>> = HashMap::new();

    for (model, entity_spec) in spec {
        let db_table = table_map
            .get(model)
            .ok_or_else(|| format!("Unknown model \"{}\". Not found in database tables.", model))?;
        let col_map = column_maps.get(model).cloned().unwrap_or_default();
        let enum_type_map = enum_type_maps.get(model).cloned().unwrap_or_default();

        // Bug 4: find actual PK field name from schema
        let model_info = schema_models.iter().find(|m| m.name == *model);
        let pk_field = model_info.and_then(|mi| mi.fields.iter().find(|f| f.is_id));
        let pk_field_name = pk_field.map(|f| f.name.as_str()).unwrap_or("id");
        let pk_field_type = pk_field.map(|f| f.field_type.as_str()).unwrap_or("String");

        let fields_list = entity_spec
            .get("fields")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let is_batch = entity_spec
            .get("batch")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let fields_list: Vec<HashMap<String, Value>> = fields_list
            .into_iter()
            .filter_map(|v| {
                v.as_object()
                    .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            })
            .collect();

        if is_batch && !fields_list.is_empty() {
            let rows = insert_batch(
                executor,
                dialect,
                db_table,
                &col_map,
                &enum_type_map,
                &fields_list,
                pk_field_name,
                pk_field_type,
            )
            .await?;
            results.insert(model.clone(), rows);
        } else {
            let mut created: Vec<HashMap<String, Value>> = Vec::new();
            for fields in &fields_list {
                let rows = insert_one(
                    executor,
                    dialect,
                    db_table,
                    &col_map,
                    &enum_type_map,
                    fields,
                    pk_field_name,
                    pk_field_type,
                )
                .await?;
                if let Some(row) = rows.into_iter().next() {
                    created.push(row);
                }
            }
            results.insert(model.clone(), created);
        }
    }

    Ok(results)
}

pub async fn update_entity(
    executor: &dyn SqlExecutor,
    dialect: &dyn Dialect,
    table_map: &HashMap<String, String>,
    column_maps: &HashMap<String, HashMap<String, String>>,
    model: &str,
    record_id: &str,
    fields: &HashMap<String, Value>,
    enum_type_maps: &HashMap<String, HashMap<String, String>>,
    pk_field_name: &str,
) -> Result<(), String> {
    let db_table = table_map
        .get(model)
        .ok_or_else(|| format!("Unknown model \"{}\" for update.", model))?;
    let col_map = column_maps.get(model).cloned().unwrap_or_default();
    let enum_type_map = enum_type_maps.get(model).cloned().unwrap_or_default();

    let mut set_clauses: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    let mut param_idx = 1;

    for (field_name, value) in fields {
        let db_col = col_map
            .get(field_name)
            .cloned()
            .unwrap_or_else(|| field_name.clone());
        set_clauses.push(format!(
            "{} = {}",
            dialect.quote_id(&db_col),
            cast_param(dialect, param_idx, &enum_type_map, field_name)
        ));
        params.push(serialize_value(value, dialect));
        param_idx += 1;
    }

    let id_col = col_map.get(pk_field_name).cloned().unwrap_or_else(|| pk_field_name.to_string());
    params.push(Value::String(record_id.to_string()));

    let sql = format!(
        "UPDATE {} SET {} WHERE {} = {}",
        dialect.quote_id(db_table),
        set_clauses.join(", "),
        dialect.quote_id(&id_col),
        dialect.param(param_idx)
    );
    executor
        .query(&sql, Some(&params))
        .await?;
    Ok(())
}

async fn insert_one(
    executor: &dyn SqlExecutor,
    dialect: &dyn Dialect,
    db_table: &str,
    col_map: &HashMap<String, String>,
    enum_type_map: &HashMap<String, String>,
    fields: &HashMap<String, Value>,
    pk_field_name: &str,
    pk_field_type: &str,
) -> Result<Vec<HashMap<String, Value>>, String> {
    let mut fields = fields.clone();

    // Bug 1 + Bug 4: Generate client-side UUID only when PK type is String.
    // Int/BigInt PKs use DB auto-increment, so skip UUID generation for those.
    if pk_field_type == "String" && !fields.contains_key(pk_field_name) {
        fields.insert(pk_field_name.to_string(), Value::String(Uuid::new_v4().to_string()));
    }

    let entries: Vec<(String, Value)> = fields.into_iter().collect();
    if entries.is_empty() {
        let sql = format!(
            "INSERT INTO {} DEFAULT VALUES RETURNING *",
            dialect.quote_id(db_table)
        );
        let rows = executor.query(&sql, None).await?;
        return Ok(map_rows_back(&rows, col_map));
    }

    let mut db_cols: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    let mut placeholders: Vec<String> = Vec::new();
    let mut param_idx = 1;

    for (field_name, value) in &entries {
        let db_col = col_map
            .get(field_name)
            .cloned()
            .unwrap_or_else(|| field_name.clone());
        db_cols.push(dialect.quote_id(&db_col));
        placeholders.push(cast_param(dialect, param_idx, enum_type_map, field_name));
        params.push(serialize_value(value, dialect));
        param_idx += 1;
    }

    let col_list = db_cols.join(", ");
    let val_list = placeholders.join(", ");

    if dialect.supports_returning() {
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({}) RETURNING *",
            dialect.quote_id(db_table),
            col_list,
            val_list
        );
        let rows = executor.query(&sql, Some(&params)).await?;
        return Ok(map_rows_back(&rows, col_map));
    }

    // MySQL: INSERT then SELECT back
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        dialect.quote_id(db_table),
        col_list,
        val_list
    );
    executor.query(&sql, Some(&params)).await?;

    let id_col = col_map.get(pk_field_name).cloned().unwrap_or_else(|| pk_field_name.to_string());
    let record_id = entries
        .iter()
        .find(|(k, _)| k == pk_field_name)
        .map(|(_, v)| v.clone())
        .unwrap_or(Value::Null);

    let select_sql = format!(
        "SELECT * FROM {} WHERE {} = {}",
        dialect.quote_id(db_table),
        dialect.quote_id(&id_col),
        dialect.param(1)
    );
    let rows = executor
        .query(&select_sql, Some(&[record_id]))
        .await?;
    Ok(map_rows_back(&rows, col_map))
}

async fn insert_batch(
    executor: &dyn SqlExecutor,
    dialect: &dyn Dialect,
    db_table: &str,
    col_map: &HashMap<String, String>,
    enum_type_map: &HashMap<String, String>,
    fields_arr: &[HashMap<String, Value>],
    pk_field_name: &str,
    pk_field_type: &str,
) -> Result<Vec<HashMap<String, Value>>, String> {
    if fields_arr.is_empty() {
        return Ok(Vec::new());
    }

    // Bug 1 + Bug 4: Generate client-side IDs only when PK type is String
    let fields_arr: Vec<HashMap<String, Value>> = fields_arr
        .iter()
        .map(|f| {
            let mut f = f.clone();
            if pk_field_type == "String" && !f.contains_key(pk_field_name) {
                f.insert(pk_field_name.to_string(), Value::String(Uuid::new_v4().to_string()));
            }
            f
        })
        .collect();

    // Compute union of keys across all rows in deterministic (sorted) order
    let field_set: BTreeSet<String> = fields_arr
        .iter()
        .flat_map(|f| f.keys().cloned())
        .collect();
    let field_names: Vec<String> = field_set.into_iter().collect();

    // If no fields at all, fall back to individual DEFAULT VALUES inserts
    if field_names.is_empty() {
        let mut all_results: Vec<HashMap<String, Value>> = Vec::new();
        for _ in fields_arr {
            let rows = insert_one(executor, dialect, db_table, col_map, enum_type_map, &HashMap::new(), pk_field_name, pk_field_type).await?;
            if let Some(row) = rows.into_iter().next() {
                all_results.push(row);
            }
        }
        return Ok(all_results);
    }

    let db_cols_list: Vec<String> = field_names
        .iter()
        .map(|f| dialect.quote_id(col_map.get(f).unwrap_or(f)))
        .collect();
    let col_list = db_cols_list.join(", ");

    // Chunk to stay within bind variable limits
    let max_params: usize = 32_000;
    let chunk_size = std::cmp::max(1, max_params / field_names.len());
    let mut all_results: Vec<HashMap<String, Value>> = Vec::new();

    for chunk in fields_arr.chunks(chunk_size) {
        let mut params: Vec<Value> = Vec::new();
        let mut value_tuples: Vec<String> = Vec::new();
        let mut param_idx = 1;

        for fields in chunk {
            let mut phs: Vec<String> = Vec::new();
            for fn_name in &field_names {
                phs.push(cast_param(dialect, param_idx, enum_type_map, fn_name));
                params.push(serialize_value(
                    fields.get(fn_name).unwrap_or(&Value::Null),
                    dialect,
                ));
                param_idx += 1;
            }
            value_tuples.push(format!("({})", phs.join(", ")));
        }

        let val_list = value_tuples.join(", ");

        if dialect.supports_returning() {
            let sql = format!(
                "INSERT INTO {} ({}) VALUES {} RETURNING *",
                dialect.quote_id(db_table),
                col_list,
                val_list
            );
            let rows = executor.query(&sql, Some(&params)).await?;
            all_results.extend(map_rows_back(&rows, col_map));
        } else {
            let sql = format!(
                "INSERT INTO {} ({}) VALUES {}",
                dialect.quote_id(db_table),
                col_list,
                val_list
            );
            executor.query(&sql, Some(&params)).await?;
        }
    }

    Ok(all_results)
}

fn map_rows_back(
    rows: &[HashMap<String, Value>],
    col_map: &HashMap<String, String>,
) -> Vec<HashMap<String, Value>> {
    if col_map.is_empty() {
        return rows.to_vec();
    }
    let reverse: HashMap<String, String> = col_map
        .iter()
        .map(|(field, db_col)| (db_col.clone(), field.clone()))
        .collect();
    rows.iter()
        .map(|row| {
            row.iter()
                .map(|(k, v)| {
                    let key = reverse.get(k).cloned().unwrap_or_else(|| k.clone());
                    (key, v.clone())
                })
                .collect()
        })
        .collect()
}

fn cast_param(
    dialect: &dyn Dialect,
    param_idx: usize,
    enum_type_map: &HashMap<String, String>,
    field_name: &str,
) -> String {
    let placeholder = dialect.param(param_idx);
    if dialect.name() == "postgres" {
        if let Some(enum_type) = enum_type_map.get(field_name) {
            return format!("{}::{}", placeholder, dialect.quote_id(enum_type));
        }
    }
    placeholder
}

fn serialize_value(value: &Value, dialect: &dyn Dialect) -> Value {
    match value {
        Value::Null => Value::Null,
        // Bug 2: Only stringify objects/maps for JSON columns.
        // Arrays are returned as native serde_json::Value::Array for Postgres ARRAY columns.
        Value::Object(_) => {
            Value::String(serde_json::to_string(value).unwrap_or_default())
        }
        Value::Array(_) => value.clone(),
        Value::String(s) => {
            // MySQL: convert ISO 8601 datetime strings
            if dialect.name() == "mysql" {
                if MYSQL_DATETIME_RE.is_match(s) {
                    let converted = s
                        .replace('T', " ")
                        .replace('Z', "")
                        .trim_end_matches('0')
                        .trim_end_matches('.')
                        .to_string();
                    return Value::String(converted);
                }
            }
            value.clone()
        }
        _ => value.clone(),
    }
}
