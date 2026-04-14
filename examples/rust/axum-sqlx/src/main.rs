use std::collections::HashMap;
use std::env;

use axum::{Router, routing::post};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;

use autonoma_sdk::axum::create_axum_handler;
use autonoma_sdk::sqlx_adapter::SqlxPostgresExecutor;
use autonoma_sdk::types::{HandlerConfig, SdkMeta};

#[tokio::main]
async fn main() {
    // 1. Connect to PostgreSQL
    let database_url = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://autonoma:autonoma@localhost:5432/autonoma_example".to_string());

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("Failed to connect to database");

    // Create tables
    sqlx::raw_sql(include_str!("../schema.sql"))
        .execute(&pool)
        .await
        .expect("Failed to create tables");

    // 2. Configure Autonoma
    let shared_secret = env::var("AUTONOMA_SHARED_SECRET")
        .unwrap_or_else(|_| "my-shared-secret".to_string());
    let signing_secret = env::var("AUTONOMA_SIGNING_SECRET")
        .unwrap_or_else(|_| "my-signing-secret".to_string());

    let config = HandlerConfig {
        executor: Box::new(SqlxPostgresExecutor::new(pool)),
        scope_field: "organization_id".to_string(),
        shared_secret,
        signing_secret,
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
        dialect: "postgres".to_string(),
        db_schema: None,
        table_name_map: None,
        exclude_tables: None,
        allow_production: false,
        sdk: Some(SdkMeta {
            orm: "sqlx".to_string(),
            server: "axum".to_string(),
        }),
        introspection_cache: tokio::sync::OnceCell::new(),
        before_down: None,
        after_up: None,
    };

    // 3. Set up Axum router
    let app = Router::new()
        .route("/api/autonoma", post(create_axum_handler(config)));

    // 4. Start server
    let port = env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let addr = format!("0.0.0.0:{}", port);
    println!("Server running on http://localhost:{}", port);
    println!("Autonoma endpoint: POST http://localhost:{}/api/autonoma", port);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
