//! Database dialect abstraction — generates dialect-specific SQL strings.

use crate::generated::sql_queries::*;

pub trait Dialect: Send + Sync {
    fn name(&self) -> &str;
    fn supports_returning(&self) -> bool;
    fn param(&self, index: usize) -> String;
    fn quote_id(&self, name: &str) -> String;
    fn tables_sql(&self, schema: &str) -> String;
    fn columns_sql(&self, schema: &str) -> String;
    fn primary_keys_sql(&self, schema: &str) -> String;
    fn foreign_keys_sql(&self, schema: &str) -> String;
    fn enums_sql(&self, schema: &str) -> String;
}

fn replace_schema(template: &str, schema: &str) -> String {
    template.replace("{{schema}}", schema)
}

pub struct PostgresDialect;

impl Dialect for PostgresDialect {
    fn name(&self) -> &str {
        "postgres"
    }
    fn supports_returning(&self) -> bool {
        true
    }
    fn param(&self, index: usize) -> String {
        format!("${}", index)
    }
    fn quote_id(&self, name: &str) -> String {
        format!("\"{}\"", name)
    }
    fn tables_sql(&self, schema: &str) -> String {
        replace_schema(POSTGRES_TABLES, schema)
    }
    fn columns_sql(&self, schema: &str) -> String {
        replace_schema(POSTGRES_COLUMNS, schema)
    }
    fn primary_keys_sql(&self, schema: &str) -> String {
        replace_schema(POSTGRES_PRIMARY_KEYS, schema)
    }
    fn foreign_keys_sql(&self, schema: &str) -> String {
        replace_schema(POSTGRES_FOREIGN_KEYS, schema)
    }
    fn enums_sql(&self, _schema: &str) -> String {
        POSTGRES_ENUMS.to_string()
    }
}

pub struct MySqlDialect;

impl Dialect for MySqlDialect {
    fn name(&self) -> &str {
        "mysql"
    }
    fn supports_returning(&self) -> bool {
        false
    }
    fn param(&self, _index: usize) -> String {
        "?".to_string()
    }
    fn quote_id(&self, name: &str) -> String {
        format!("`{}`", name)
    }
    fn tables_sql(&self, schema: &str) -> String {
        replace_schema(MYSQL_TABLES, schema)
    }
    fn columns_sql(&self, schema: &str) -> String {
        replace_schema(MYSQL_COLUMNS, schema)
    }
    fn primary_keys_sql(&self, schema: &str) -> String {
        replace_schema(MYSQL_PRIMARY_KEYS, schema)
    }
    fn foreign_keys_sql(&self, schema: &str) -> String {
        replace_schema(MYSQL_FOREIGN_KEYS, schema)
    }
    fn enums_sql(&self, _schema: &str) -> String {
        MYSQL_ENUMS.to_string()
    }
}

pub fn get_dialect(name: &str) -> Box<dyn Dialect> {
    match name {
        "postgres" => Box::new(PostgresDialect),
        "mysql" => Box::new(MySqlDialect),
        _ => panic!(
            "Dialect \"{}\" is not yet supported. Currently only \"postgres\" and \"mysql\" are available.",
            name
        ),
    }
}
