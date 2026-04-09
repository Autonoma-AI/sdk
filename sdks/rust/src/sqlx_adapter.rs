//! SQLx-based SQL executor for the Autonoma SDK.
//!
//! Provides database executors wrapping SQLx connection pools into
//! the `SqlExecutor` trait required by the handler.
//!
//! - `SqlxPostgresExecutor` (feature `sqlx-postgres`): wraps `sqlx::PgPool`
//! - `SqlxMysqlExecutor` (feature `sqlx-mysql`): wraps `sqlx::MySqlPool`

#[cfg(any(feature = "sqlx-postgres", feature = "sqlx-mysql"))]
mod inner {
    use async_trait::async_trait;
    use serde_json::Value;
    use sqlx::{Column, Row, TypeInfo};
    use std::collections::HashMap;

    use crate::types::SqlExecutor;

    /// Map a column value to a serde_json::Value based on the SQL type name.
    macro_rules! map_row_columns {
        ($rows:expr) => {{
            let mut results: Vec<HashMap<String, Value>> = Vec::new();
            for row in $rows {
                let mut map = HashMap::new();
                for col in row.columns() {
                    let name = col.name().to_string();
                    let val: Value = match col.type_info().name() {
                        "TEXT" | "VARCHAR" | "CHAR" | "UUID" | "NAME"
                        | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" => {
                            let v: Option<String> = row.try_get(col.ordinal()).ok().flatten();
                            v.map(Value::String).unwrap_or(Value::Null)
                        }
                        "INT4" | "INT8" | "INT2" | "SERIAL" | "BIGSERIAL"
                        | "INT" | "BIGINT" | "SMALLINT" | "TINYINT" | "MEDIUMINT"
                        | "INT UNSIGNED" | "BIGINT UNSIGNED" => {
                            let v: Option<i64> = row.try_get(col.ordinal()).ok().flatten();
                            v.map(|n| Value::Number(n.into())).unwrap_or(Value::Null)
                        }
                        "FLOAT4" | "FLOAT8" | "NUMERIC"
                        | "FLOAT" | "DOUBLE" | "DECIMAL" => {
                            let v: Option<f64> = row.try_get(col.ordinal()).ok().flatten();
                            v.and_then(|f| serde_json::Number::from_f64(f).map(Value::Number))
                                .unwrap_or(Value::Null)
                        }
                        "BOOL" | "BOOLEAN" => {
                            let v: Option<bool> = row.try_get(col.ordinal()).ok().flatten();
                            v.map(Value::Bool).unwrap_or(Value::Null)
                        }
                        "JSON" | "JSONB" => {
                            let v: Option<Value> = row.try_get(col.ordinal()).ok().flatten();
                            v.unwrap_or(Value::Null)
                        }
                        _ => {
                            // Fallback: try as string
                            let v: Option<String> = row.try_get(col.ordinal()).ok().flatten();
                            v.map(Value::String).unwrap_or(Value::Null)
                        }
                    };
                    map.insert(name, val);
                }
                results.push(map);
            }
            results
        }};
    }

    /// Bind serde_json::Value params to a sqlx::Query.
    macro_rules! bind_params {
        ($query:expr, $params:expr) => {{
            let mut query = $query;
            if let Some(params) = $params {
                for param in params {
                    query = match param {
                        Value::String(s) => query.bind(s.clone()),
                        Value::Number(n) => {
                            if let Some(i) = n.as_i64() {
                                query.bind(i)
                            } else if let Some(f) = n.as_f64() {
                                query.bind(f)
                            } else {
                                query.bind(n.to_string())
                            }
                        }
                        Value::Bool(b) => query.bind(*b),
                        Value::Null => query.bind(Option::<String>::None),
                        _ => query.bind(serde_json::to_string(param).unwrap_or_default()),
                    };
                }
            }
            query
        }};
    }

    // ── Postgres ────────────────────────────────────────────────────────

    /// SQLx executor wrapping a Postgres connection pool.
    #[cfg(feature = "sqlx-postgres")]
    pub struct SqlxPostgresExecutor {
        pool: sqlx::PgPool,
    }

    #[cfg(feature = "sqlx-postgres")]
    impl SqlxPostgresExecutor {
        pub fn new(pool: sqlx::PgPool) -> Self {
            Self { pool }
        }
    }

    #[cfg(feature = "sqlx-postgres")]
    struct SqlxPostgresTxExecutor {
        tx: tokio::sync::Mutex<sqlx::Transaction<'static, sqlx::Postgres>>,
    }

    #[cfg(feature = "sqlx-postgres")]
    #[async_trait]
    impl SqlExecutor for SqlxPostgresExecutor {
        async fn query(
            &self,
            sql: &str,
            params: Option<&[Value]>,
        ) -> Result<Vec<HashMap<String, Value>>, String> {
            let query = bind_params!(sqlx::query(sql), params);
            let rows = query
                .fetch_all(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
            Ok(map_row_columns!(&rows))
        }

        async fn transaction(
            &self,
            f: Box<
                dyn for<'a> FnOnce(
                        &'a dyn SqlExecutor,
                    )
                        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>
                    + Send,
            >,
        ) -> Result<(), String> {
            let tx = self.pool.begin().await.map_err(|e| e.to_string())?;
            let tx_exec = SqlxPostgresTxExecutor {
                tx: tokio::sync::Mutex::new(tx),
            };
            let result = f(&tx_exec).await;
            let tx = tx_exec.tx.into_inner();
            match result {
                Ok(()) => {
                    tx.commit().await.map_err(|e| e.to_string())?;
                    Ok(())
                }
                Err(e) => {
                    tx.rollback().await.ok();
                    Err(e)
                }
            }
        }
    }

    #[cfg(feature = "sqlx-postgres")]
    #[async_trait]
    impl SqlExecutor for SqlxPostgresTxExecutor {
        async fn query(
            &self,
            sql: &str,
            params: Option<&[Value]>,
        ) -> Result<Vec<HashMap<String, Value>>, String> {
            let query = bind_params!(sqlx::query(sql), params);
            let mut guard = self.tx.lock().await;
            let rows = query
                .fetch_all(&mut **guard)
                .await
                .map_err(|e| e.to_string())?;
            Ok(map_row_columns!(&rows))
        }

        async fn transaction(
            &self,
            f: Box<
                dyn for<'a> FnOnce(
                        &'a dyn SqlExecutor,
                    )
                        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>
                    + Send,
            >,
        ) -> Result<(), String> {
            // Already in a transaction — run the callback directly
            f(self).await
        }
    }

    // ── MySQL ───────────────────────────────────────────────────────────

    /// SQLx executor wrapping a MySQL connection pool.
    #[cfg(feature = "sqlx-mysql")]
    pub struct SqlxMysqlExecutor {
        pool: sqlx::MySqlPool,
    }

    #[cfg(feature = "sqlx-mysql")]
    impl SqlxMysqlExecutor {
        pub fn new(pool: sqlx::MySqlPool) -> Self {
            Self { pool }
        }
    }

    #[cfg(feature = "sqlx-mysql")]
    struct SqlxMysqlTxExecutor {
        tx: tokio::sync::Mutex<sqlx::Transaction<'static, sqlx::MySql>>,
    }

    #[cfg(feature = "sqlx-mysql")]
    #[async_trait]
    impl SqlExecutor for SqlxMysqlExecutor {
        async fn query(
            &self,
            sql: &str,
            params: Option<&[Value]>,
        ) -> Result<Vec<HashMap<String, Value>>, String> {
            let query = bind_params!(sqlx::query(sql), params);
            let rows = query
                .fetch_all(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
            Ok(map_row_columns!(&rows))
        }

        async fn transaction(
            &self,
            f: Box<
                dyn for<'a> FnOnce(
                        &'a dyn SqlExecutor,
                    )
                        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>
                    + Send,
            >,
        ) -> Result<(), String> {
            let tx = self.pool.begin().await.map_err(|e| e.to_string())?;
            let tx_exec = SqlxMysqlTxExecutor {
                tx: tokio::sync::Mutex::new(tx),
            };
            let result = f(&tx_exec).await;
            let tx = tx_exec.tx.into_inner();
            match result {
                Ok(()) => {
                    tx.commit().await.map_err(|e| e.to_string())?;
                    Ok(())
                }
                Err(e) => {
                    tx.rollback().await.ok();
                    Err(e)
                }
            }
        }
    }

    #[cfg(feature = "sqlx-mysql")]
    #[async_trait]
    impl SqlExecutor for SqlxMysqlTxExecutor {
        async fn query(
            &self,
            sql: &str,
            params: Option<&[Value]>,
        ) -> Result<Vec<HashMap<String, Value>>, String> {
            let query = bind_params!(sqlx::query(sql), params);
            let mut guard = self.tx.lock().await;
            let rows = query
                .fetch_all(&mut **guard)
                .await
                .map_err(|e| e.to_string())?;
            Ok(map_row_columns!(&rows))
        }

        async fn transaction(
            &self,
            f: Box<
                dyn for<'a> FnOnce(
                        &'a dyn SqlExecutor,
                    )
                        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>
                    + Send,
            >,
        ) -> Result<(), String> {
            // Already in a transaction — run the callback directly
            f(self).await
        }
    }
}

#[cfg(any(feature = "sqlx-postgres", feature = "sqlx-mysql"))]
pub use inner::*;
