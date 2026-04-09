//! Introspect a database via information_schema to build SchemaInfo.

use regex::Regex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use crate::dialect::Dialect;
use crate::types::{
    FKEdge, FieldInfo, IntrospectionResult, ModelInfo, SchemaInfo, SchemaRelation, SqlExecutor,
};

static MYSQL_ENUM_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^enum\((.+)\)$").unwrap());

pub async fn introspect_database(
    executor: &dyn SqlExecutor,
    dialect: &dyn Dialect,
    scope_field: &str,
    schema: Option<&str>,
    table_name_map: Option<&HashMap<String, String>>,
    exclude_tables: Option<&[String]>,
) -> Result<IntrospectionResult, String> {
    let db_schema = schema
        .or(if dialect.name() != "mysql" {
            Some("public")
        } else {
            None
        })
        .ok_or_else(|| {
            "MySQL requires a schema (database name). Pass it via db_schema or HandlerConfig.db_schema.".to_string()
        })?;

    let exclude_set: HashSet<&str> = exclude_tables
        .map(|t| t.iter().map(|s| s.as_str()).collect())
        .unwrap_or_else(|| {
            let mut s = HashSet::new();
            s.insert("_prisma_migrations");
            s
        });

    // Run all introspection queries
    let table_rows = executor
        .query(&dialect.tables_sql(db_schema), None)
        .await?;
    let column_rows = executor
        .query(&dialect.columns_sql(db_schema), None)
        .await?;
    let pk_rows = executor
        .query(&dialect.primary_keys_sql(db_schema), None)
        .await?;
    let fk_rows = executor
        .query(&dialect.foreign_keys_sql(db_schema), None)
        .await?;
    let enum_rows = executor.query(&dialect.enums_sql(db_schema), None).await?;

    // Normalize keys to lowercase
    let table_rows = normalize_keys(&table_rows);
    let column_rows = normalize_keys(&column_rows);
    let pk_rows = normalize_keys(&pk_rows);
    let fk_rows = normalize_keys(&fk_rows);
    let enum_rows = normalize_keys(&enum_rows);

    // Build enum lookup
    let mut enum_values: HashMap<String, Vec<String>> = HashMap::new();
    for row in &enum_rows {
        if let Some(name) = row.get("enum_name").and_then(|v| v.as_str()) {
            if let Some(val) = row.get("enum_value").and_then(|v| v.as_str()) {
                enum_values
                    .entry(name.to_string())
                    .or_default()
                    .push(val.to_string());
            }
        }
    }

    // MySQL: parse inline enums from column_type
    if dialect.name() == "mysql" {
        for col in &column_rows {
            let udt_name = get_str(col, "udt_name");
            if let Some(parsed) = parse_mysql_enum(&udt_name) {
                let key = format!(
                    "{}.{}",
                    get_str(col, "table_name"),
                    get_str(col, "column_name")
                );
                enum_values.insert(key, parsed);
            }
        }
    }

    // Build PK lookup
    let mut pks_by_table: HashMap<String, HashSet<String>> = HashMap::new();
    for row in &pk_rows {
        pks_by_table
            .entry(get_str(row, "table_name"))
            .or_default()
            .insert(get_str(row, "column_name"));
    }

    // Build table name mapping
    let user_map = table_name_map.cloned().unwrap_or_default();
    let mut table_map: HashMap<String, String> = HashMap::new();
    let mut reverse_table_map: HashMap<String, String> = HashMap::new();

    for (model, db_table) in &user_map {
        table_map.insert(model.clone(), db_table.clone());
        reverse_table_map.insert(db_table.clone(), model.clone());
    }

    let db_tables: Vec<String> = table_rows
        .iter()
        .map(|r| get_str(r, "table_name"))
        .filter(|t| !exclude_set.contains(t.as_str()))
        .collect();

    for db_table in &db_tables {
        if reverse_table_map.contains_key(db_table) {
            continue;
        }
        let model_name = snake_to_pascal(db_table);
        table_map.insert(model_name.clone(), db_table.clone());
        reverse_table_map.insert(db_table.clone(), model_name);
    }

    // Group columns by table
    let mut columns_by_table: HashMap<String, Vec<HashMap<String, Value>>> = HashMap::new();
    for row in &column_rows {
        columns_by_table
            .entry(get_str(row, "table_name"))
            .or_default()
            .push(row.clone());
    }

    // Build models and column maps
    let mut models: Vec<ModelInfo> = Vec::new();
    let mut column_maps: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut enum_type_maps: HashMap<String, HashMap<String, String>> = HashMap::new();

    for (model_name, db_table) in &table_map {
        let cols = columns_by_table.get(db_table).cloned().unwrap_or_default();
        let pks = pks_by_table.get(db_table).cloned().unwrap_or_default();
        let mut col_map: HashMap<String, String> = HashMap::new();
        let mut fields: Vec<FieldInfo> = Vec::new();

        for col in &cols {
            let column_name = get_str(col, "column_name");
            let field_name = snake_to_camel(&column_name);
            col_map.insert(field_name.clone(), column_name.clone());

            // Check for enums
            let enum_vals = if dialect.name() == "mysql" {
                let key = format!("{}.{}", db_table, column_name);
                enum_values.get(&key).cloned()
            } else {
                let udt = get_str(col, "udt_name");
                enum_values.get(&udt).cloned()
            };

            let field_type = if let Some(ref vals) = enum_vals {
                format!("enum({})", vals.join(","))
            } else {
                map_data_type(
                    &get_str(col, "data_type"),
                    &get_str(col, "udt_name"),
                    dialect.name(),
                )
            };

            // Track Postgres types needing casts
            if dialect.name() == "postgres" {
                let data_type = get_str(col, "data_type");
                let udt_name = get_str(col, "udt_name");

                if enum_vals.is_some() {
                    enum_type_maps
                        .entry(model_name.clone())
                        .or_default()
                        .insert(field_name.clone(), udt_name.clone());
                } else if data_type == "jsonb"
                    || data_type == "json"
                    || udt_name == "jsonb"
                    || udt_name == "json"
                {
                    let json_type =
                        if data_type == "json" || udt_name == "json" {
                            "json"
                        } else {
                            "jsonb"
                        };
                    enum_type_maps
                        .entry(model_name.clone())
                        .or_default()
                        .insert(field_name.clone(), json_type.to_string());
                } else if data_type.contains("timestamp")
                    || udt_name == "timestamptz"
                    || udt_name == "timestamp"
                {
                    enum_type_maps
                        .entry(model_name.clone())
                        .or_default()
                        .insert(field_name.clone(), udt_name.clone());
                }
            }

            fields.push(FieldInfo {
                name: field_name,
                field_type,
                is_required: get_str(col, "is_nullable") == "NO",
                is_id: pks.contains(&column_name),
                has_default: !col
                    .get("column_default")
                    .map(|v| v.is_null())
                    .unwrap_or(true),
            });
        }

        column_maps.insert(model_name.clone(), col_map);
        models.push(ModelInfo {
            name: model_name.clone(),
            table_name: db_table.clone(),
            fields,
        });
    }

    // Build FK edges
    let mut edges: Vec<FKEdge> = Vec::new();
    for fk in &fk_rows {
        let from_table = get_str(fk, "from_table");
        let to_table = get_str(fk, "to_table");
        let from_model = match reverse_table_map.get(&from_table) {
            Some(m) => m.clone(),
            None => continue,
        };
        let to_model = match reverse_table_map.get(&to_table) {
            Some(m) => m.clone(),
            None => continue,
        };

        let from_col_map = column_maps.get(&from_model).cloned().unwrap_or_default();
        let to_col_map = column_maps.get(&to_model).cloned().unwrap_or_default();
        let from_column = get_str(fk, "from_column");
        let to_column = get_str(fk, "to_column");
        let local_field = reverse_get(&from_col_map, &from_column).unwrap_or(from_column);
        let foreign_field = reverse_get(&to_col_map, &to_column).unwrap_or(to_column);

        edges.push(FKEdge {
            from_model,
            to_model,
            local_field,
            foreign_field,
            nullable: get_str(fk, "is_nullable") == "YES",
        });
    }

    // Build relations from FK edges
    let mut relations: Vec<SchemaRelation> = Vec::new();
    for edge in &edges {
        let from_db_table = table_map.get(&edge.from_model).cloned().unwrap_or_default();
        let from_col_map = column_maps.get(&edge.from_model).cloned().unwrap_or_default();
        let fk_db_col = from_col_map
            .get(&edge.local_field)
            .cloned()
            .unwrap_or_else(|| edge.local_field.clone());
        let from_pks = pks_by_table.get(&from_db_table).cloned().unwrap_or_default();
        let is_one_to_one = from_pks.len() == 1 && from_pks.contains(&fk_db_col);

        // Parent-side
        relations.push(SchemaRelation {
            parent_model: edge.to_model.clone(),
            child_model: edge.from_model.clone(),
            parent_field: if is_one_to_one {
                lower_first(&edge.from_model)
            } else {
                plural_camel_case(&edge.from_model)
            },
            child_field: edge.local_field.clone(),
        });

        // Child-side
        relations.push(SchemaRelation {
            parent_model: edge.from_model.clone(),
            child_model: edge.to_model.clone(),
            parent_field: lower_first(&edge.to_model),
            child_field: edge.local_field.clone(),
        });
    }

    let schema_info = SchemaInfo {
        models,
        edges,
        relations,
        scope_field: scope_field.to_string(),
    };

    Ok(IntrospectionResult {
        schema: schema_info,
        table_map,
        column_maps,
        enum_type_maps,
    })
}

// --- Name mapping utilities ---

fn snake_to_pascal(s: &str) -> String {
    s.split('_')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let mut chars = p.chars();
            match chars.next() {
                None => String::new(),
                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
            }
        })
        .collect()
}

fn snake_to_camel(s: &str) -> String {
    let pascal = snake_to_pascal(s);
    if pascal.is_empty() {
        return String::new();
    }
    let mut chars = pascal.chars();
    chars
        .next()
        .unwrap()
        .to_lowercase()
        .collect::<String>()
        + chars.as_str()
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

fn plural_camel_case(model_name: &str) -> String {
    let camel = lower_first(model_name);
    pluralize(&camel)
}

fn pluralize(s: &str) -> String {
    if s.ends_with('s')
        || s.ends_with('x')
        || s.ends_with('z')
        || s.ends_with("ch")
        || s.ends_with("sh")
    {
        format!("{}es", s)
    } else if s.ends_with('y') && s.len() > 1 && !"aeiou".contains(s.chars().rev().nth(1).unwrap())
    {
        format!("{}ies", &s[..s.len() - 1])
    } else {
        format!("{}s", s)
    }
}

fn parse_mysql_enum(column_type: &str) -> Option<Vec<String>> {
    if column_type.is_empty() {
        return None;
    }
    let caps = MYSQL_ENUM_RE.captures(column_type)?;
    let inner = caps.get(1)?.as_str();
    Some(
        inner
            .split(',')
            .map(|v| v.trim().trim_matches('\'').to_string())
            .collect(),
    )
}

fn map_data_type(data_type: &str, udt_name: &str, dialect_name: &str) -> String {
    let dt = data_type.to_lowercase();
    match dt.as_str() {
        "tinyint" if dialect_name == "mysql" && udt_name.to_lowercase() == "tinyint(1)" => {
            "Boolean".to_string()
        }
        "integer" | "smallint" | "bigint" | "int" | "mediumint" | "tinyint" => "Int".to_string(),
        "numeric" | "real" | "double precision" | "float" | "double" | "decimal" => {
            "Float".to_string()
        }
        "boolean" => "Boolean".to_string(),
        "text" | "character varying" | "character" | "varchar" | "char" | "mediumtext"
        | "longtext" | "tinytext" => "String".to_string(),
        "timestamp with time zone" | "timestamp without time zone" | "date" | "time"
        | "datetime" | "timestamp" => "DateTime".to_string(),
        "json" | "jsonb" => "Json".to_string(),
        "uuid" => "String".to_string(),
        "bytea" | "blob" | "mediumblob" | "longblob" | "tinyblob" | "binary" | "varbinary" => {
            "Bytes".to_string()
        }
        "user-defined" if dialect_name == "postgres" => udt_name.to_string(),
        "enum" | "set" => udt_name.to_string(),
        _ => data_type.to_string(),
    }
}

fn normalize_keys(rows: &[HashMap<String, Value>]) -> Vec<HashMap<String, Value>> {
    rows.iter()
        .map(|row| {
            row.iter()
                .map(|(k, v)| (k.to_lowercase(), v.clone()))
                .collect()
        })
        .collect()
}

fn get_str(row: &HashMap<String, Value>, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn reverse_get(mapping: &HashMap<String, String>, db_name: &str) -> Option<String> {
    mapping
        .iter()
        .find(|(_, v)| v.as_str() == db_name)
        .map(|(k, _)| k.clone())
}
