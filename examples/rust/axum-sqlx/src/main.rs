// =============================================================================
// Autonoma SDK — Axum Example (Factory-driven)
// =============================================================================
// The SDK is factory-driven: every model the dashboard can create has a
// registered factory whose input_fields drives both validation and the
// discover schema. There is no SQL introspection, no SQLx executor, and
// no SQL fallback — your factories call whatever services your app has.

use std::collections::HashMap;
use std::env;

use axum::{Router, routing::post};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use autonoma_sdk::axum::create_axum_handler;
use autonoma_sdk::factory::define_factory;
use autonoma_sdk::types::{FieldDef, FactoryRegistry, HandlerConfig, SdkMeta};

// =============================================================================
// Repository functions (free functions style)
// =============================================================================

async fn create_organization(
    pool: &PgPool,
    data: &Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("unnamed");

    let row: (String,) = sqlx::query_as(
        "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
    )
    .bind(name)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("creating organization: {e}"))?;

    let mut result = Map::new();
    result.insert("id".into(), Value::String(row.0));
    result.insert("name".into(), Value::String(name.to_string()));
    Ok(result)
}

async fn delete_organization(pool: &PgPool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM organizations WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("deleting organization: {e}"))?;
    Ok(())
}

async fn create_user(
    pool: &PgPool,
    data: &Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    let email = data.get("email").and_then(|v| v.as_str()).unwrap_or("");
    let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let org_id = data.get("organization_id").and_then(|v| v.as_str()).unwrap_or("");

    let normalized_email = email.trim().to_lowercase();
    let _hashed_password = format!(
        "{:x}",
        Sha256::new().chain_update(b"default-test-password").finalize()
    );

    let row: (String,) = sqlx::query_as(
        "INSERT INTO users (email, name, organization_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(&normalized_email)
    .bind(name)
    .bind(org_id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("creating user: {e}"))?;

    let mut result = Map::new();
    result.insert("id".into(), Value::String(row.0));
    result.insert("email".into(), Value::String(normalized_email));
    result.insert("name".into(), Value::String(name.to_string()));
    result.insert("organization_id".into(), Value::String(org_id.to_string()));
    Ok(result)
}

// =============================================================================
// Main
// =============================================================================

#[tokio::main]
async fn main() {
    let database_url = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://autonoma:autonoma@localhost:5432/autonoma_example".into());

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("Failed to connect to database");

    sqlx::raw_sql(include_str!("../schema.sql"))
        .execute(&pool)
        .await
        .expect("Failed to create tables");

    let shared_secret = env::var("AUTONOMA_SHARED_SECRET")
        .unwrap_or_else(|_| "my-shared-secret".into());
    let signing_secret = env::var("AUTONOMA_SIGNING_SECRET")
        .unwrap_or_else(|_| "my-signing-secret".into());

    // Every model the dashboard can create needs a factory.
    // The factory's input_fields drives both validation and discover.
    let pool_org = pool.clone();
    let pool_org_del = pool.clone();
    let pool_user = pool.clone();

    let mut factories: FactoryRegistry = HashMap::new();

    factories.insert(
        "Organization".to_string(),
        define_factory(
            vec![FieldDef::required("name", "string")],
            move |data, _ctx| {
                let pool = pool_org.clone();
                Box::pin(async move {
                    create_organization(&pool, data)
                        .await
                        .map(|m| Value::Object(m))
                        .map_err(|e| autonoma_sdk::errors::AutonomaError {
                            message: e,
                            code: "FACTORY_CREATE_FAILED".into(),
                            status: 500,
                        })
                })
            },
            Some(move |record: &Map<String, Value>, _ctx: &autonoma_sdk::types::FactoryContext<'_>| {
                let pool = pool_org_del.clone();
                let id = record.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                Box::pin(async move {
                    delete_organization(&pool, &id)
                        .await
                        .map_err(|e| autonoma_sdk::errors::AutonomaError {
                            message: e,
                            code: "FACTORY_TEARDOWN_FAILED".into(),
                            status: 500,
                        })
                })
            }),
        ),
    );

    // data is validated against input_fields before reaching this closure
    factories.insert(
        "User".to_string(),
        define_factory(
            vec![
                FieldDef::required("email", "string"),
                FieldDef::required("name", "string"),
                FieldDef::required("organization_id", "string"),
            ],
            move |data, _ctx| {
                let pool = pool_user.clone();
                Box::pin(async move {
                    create_user(&pool, data)
                        .await
                        .map(|m| Value::Object(m))
                        .map_err(|e| autonoma_sdk::errors::AutonomaError {
                            message: e,
                            code: "FACTORY_CREATE_FAILED".into(),
                            status: 500,
                        })
                })
            },
            None::<fn(&Map<String, Value>, &autonoma_sdk::types::FactoryContext<'_>) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), autonoma_sdk::errors::AutonomaError>> + Send + '_>>>,
        ),
    );

    // allow_production is a required struct field kept for backward
    // compatibility; it is a deprecated no-op - the endpoint is always
    // enabled and HMAC signing is the gate.
    #[allow(deprecated)]
    let config = HandlerConfig {
        scope_field: "organization_id".to_string(),
        shared_secret,
        signing_secret,
        factories: Some(factories),
        auth: Box::new(|_user, _ctx| {
            let mut result = HashMap::new();
            result.insert(
                "headers".to_string(),
                Value::Object(serde_json::Map::from_iter([(
                    "Authorization".to_string(),
                    Value::String("Bearer test-token".to_string()),
                )])),
            );
            result
        }),
        allow_production: true,
        sdk: Some(SdkMeta {
            orm: "sqlx".to_string(),
            server: "axum".to_string(),
        }),
        before_down: None,
        after_up: None,
    };

    let app = Router::new()
        .route("/api/autonoma", post(create_axum_handler(config)));

    let port = env::var("PORT").unwrap_or_else(|_| "3000".into());
    let addr = format!("0.0.0.0:{}", port);
    println!("Server running on http://localhost:{}", port);
    println!("Autonoma endpoint: POST http://localhost:{}/api/autonoma", port);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
