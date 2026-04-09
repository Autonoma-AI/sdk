//! SQLx-based SQL executor for the Autonoma SDK.
//!
//! Provides `SqlxExecutor` which wraps a SQLx `PgPool` or `MySqlPool` into
//! the `SqlExecutor` trait required by the handler.

#[cfg(any(feature = "sqlx-postgres", feature = "sqlx-mysql"))]
mod inner {
    use async_trait::async_trait;
    use serde_json::Value;
    use std::collections::HashMap;

    use crate::types::SqlExecutor;

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
    #[async_trait]
    impl SqlExecutor for SqlxPostgresExecutor {
        async fn query(
            &self,
            sql: &str,
            params: Option<&[Value]>,
        ) -> Result<Vec<HashMap<String, Value>>, String> {
            // Convert $N style params to sqlx bindable format
            let mut query = sqlx::query(sql);

            if let Some(params) = params {
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

            let rows = query
                .fetch_all(&self.pool)
                .await
                .map_err(|e| e.to_string())?;

            let mut results: Vec<HashMap<String, Value>> = Vec::new();
            for row in &rows {
                use sqlx::Row;
                let mut map = HashMap::new();
                for col in row.columns() {
                    let name = col.name().to_string();
                    let val: Value = match col.type_info().name() {
                        "TEXT" | "VARCHAR" | "CHAR" | "UUID" | "NAME" => {
                            let v: Option<String> = row.try_get(col.ordinal()).ok().flatten();
                            v.map(Value::String).unwrap_or(Value::Null)
                        }
                        "INT4" | "INT8" | "INT2" | "SERIAL" | "BIGSERIAL" => {
                            let v: Option<i64> = row.try_get(col.ordinal()).ok().flatten();
                            v.map(|n| Value::Number(n.into())).unwrap_or(Value::Null)
                        }
                        "FLOAT4" | "FLOAT8" | "NUMERIC" => {
                            let v: Option<f64> = row.try_get(col.ordinal()).ok().flatten();
                            v.and_then(|f| serde_json::Number::from_f64(f).map(Value::Number))
                                .unwrap_or(Value::Null)
                        }
                        "BOOL" => {
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

            Ok(results)
        }

        async fn transaction(
            &self,
            f: Box<
                dyn FnOnce(
                        &dyn SqlExecutor,
                    )
                        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>
                    + Send,
            >,
        ) -> Result<(), String> {
            let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
            // For now, execute the function with self (pool-level)
            // A full implementation would wrap the transaction handle
            let result = f(self).await;
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
}

#[cfg(any(feature = "sqlx-postgres", feature = "sqlx-mysql"))]
pub use inner::*;
