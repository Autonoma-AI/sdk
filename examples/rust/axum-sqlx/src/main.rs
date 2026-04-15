// =============================================================================
// Autonoma SDK — Axum + SQLx Example (Hybrid Factories + SQL)
// =============================================================================
// This example shows how to use factories for models with business logic
// (Organization, User) while letting the SDK handle simpler models (Project,
// Task) via raw SQL. This "hybrid" approach gives you the best of both worlds:
// correct business logic where it matters, zero setup where it doesn't.

use std::collections::HashMap;
use std::env;

use axum::{Router, routing::post};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::postgres::PgPoolOptions;

use autonoma_sdk::axum::create_axum_handler;
use autonoma_sdk::errors::AutonomaError;
use autonoma_sdk::factory::define_factory;
use autonoma_sdk::sqlx_adapter::SqlxPostgresExecutor;
use autonoma_sdk::types::{FactoryContext, FactoryRegistry, HandlerConfig, SdkMeta};

// =============================================================================
// Organization repository
// =============================================================================
// A typical repository that wraps raw SQL with business logic.
// In a real app, this might generate slugs, set up billing, create default
// settings, or call external services (e.g., Stripe customer creation).

async fn create_organization(
    data: HashMap<String, Value>,
    ctx: &FactoryContext<'_>,
) -> Result<HashMap<String, Value>, AutonomaError> {
    let name = data
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("unnamed");

    // Business logic: in a real app you might also:
    // - Generate a unique slug from the name
    // - Create a Stripe customer
    // - Set up default organization settings
    // - Send a welcome email to the creator

    let sql = r#"
        INSERT INTO organizations (name)
        VALUES ($1)
        RETURNING id, name
    "#;

    let rows = ctx
        .executor
        .query(sql, Some(&[Value::String(name.to_string())]))
        .await
        .map_err(|e| AutonomaError {
            message: format!("Failed to create organization: {}", e),
            code: "FACTORY_CREATE_FAILED".to_string(),
            status: 500,
        })?;

    rows.into_iter().next().ok_or_else(|| AutonomaError {
        message: "No row returned from organization insert".to_string(),
        code: "FACTORY_CREATE_FAILED".to_string(),
        status: 500,
    })
}

async fn delete_organization(
    record: &HashMap<String, Value>,
    ctx: &FactoryContext<'_>,
) -> Result<(), AutonomaError> {
    let id = record.get("id").ok_or_else(|| AutonomaError {
        message: "Organization record missing id".to_string(),
        code: "FACTORY_TEARDOWN_FAILED".to_string(),
        status: 500,
    })?;

    // Business logic: clean up external resources before deleting.
    // In a real app: cancel Stripe subscription, revoke API keys, etc.

    let sql = "DELETE FROM organizations WHERE id = $1";
    ctx.executor
        .query(sql, Some(&[id.clone()]))
        .await
        .map_err(|e| AutonomaError {
            message: format!("Failed to delete organization: {}", e),
            code: "FACTORY_TEARDOWN_FAILED".to_string(),
            status: 500,
        })?;

    Ok(())
}

// =============================================================================
// User repository
// =============================================================================
// A typical repository with business logic that raw SQL can't replicate.
// Password hashing, email normalization, and welcome email suppression
// are common examples of why factories are needed.

async fn create_user(
    data: HashMap<String, Value>,
    ctx: &FactoryContext<'_>,
) -> Result<HashMap<String, Value>, AutonomaError> {
    let email = data
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown@example.com");
    let name = data
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("unnamed");
    let organization_id = data.get("organization_id").ok_or_else(|| AutonomaError {
        message: "User data missing organization_id".to_string(),
        code: "FACTORY_CREATE_FAILED".to_string(),
        status: 500,
    })?;

    // Business logic: normalize email, hash a default password.
    // This shows why raw SQL INSERT would break: it doesn't know
    // about password hashing, email normalization, etc.
    let normalized_email = email.trim().to_lowercase();
    let hashed_password = format!("{:x}", Sha256::new().chain_update(b"default-test-password").finalize());

    let sql = r#"
        INSERT INTO users (email, name, organization_id, password_hash)
        VALUES ($1, $2, $3, $4)
        RETURNING id, email, name, organization_id
    "#;

    let rows = ctx
        .executor
        .query(
            sql,
            Some(&[
                Value::String(normalized_email),
                Value::String(name.to_string()),
                organization_id.clone(),
                Value::String(hashed_password),
            ]),
        )
        .await
        .map_err(|e| AutonomaError {
            message: format!("Failed to create user: {}", e),
            code: "FACTORY_CREATE_FAILED".to_string(),
            status: 500,
        })?;

    rows.into_iter().next().ok_or_else(|| AutonomaError {
        message: "No row returned from user insert".to_string(),
        code: "FACTORY_CREATE_FAILED".to_string(),
        status: 500,
    })
}

// =============================================================================
// Main
// =============================================================================

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

    // 2. Configure Autonoma with Hybrid Factories
    let shared_secret = env::var("AUTONOMA_SHARED_SECRET")
        .unwrap_or_else(|_| "my-shared-secret".to_string());
    let signing_secret = env::var("AUTONOMA_SIGNING_SECRET")
        .unwrap_or_else(|_| "my-signing-secret".to_string());

    // ---------------------------------------------------------------------------
    // Factory registration — hybrid mode
    // ---------------------------------------------------------------------------
    // Register factories for models that have business logic (Organization, User).
    // Models without a factory (Project, Task) fall back to raw SQL INSERT,
    // which works fine for simple tables without business logic.
    let mut factories: FactoryRegistry = HashMap::new();

    // Organization: uses repository logic that handles slug generation,
    // default settings, external service setup, etc.
    // Has a custom teardown to clean up external resources.
    factories.insert(
        "Organization".to_string(),
        define_factory(
            |data, ctx| Box::pin(create_organization(data, ctx)),
            Some(|record: &HashMap<String, Value>, ctx: &FactoryContext<'_>| {
                Box::pin(delete_organization(record, ctx))
            }),
        ),
    );

    // User: uses repository logic that handles password hashing,
    // email normalization, and other business logic.
    // No teardown defined — the SDK falls back to SQL DELETE.
    factories.insert(
        "User".to_string(),
        define_factory(
            |data, ctx| Box::pin(create_user(data, ctx)),
            None::<fn(&HashMap<String, Value>, &FactoryContext<'_>) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), AutonomaError>> + Send + '_>>>,
        ),
    );

    // Project and Task have no factories — they use raw SQL INSERT.
    // This is fine because they're simple tables with no business logic.

    let config = HandlerConfig {
        // Connects the SDK to your database through your ORM (Prisma, Drizzle, SQLAlchemy, etc.)
        executor: Box::new(SqlxPostgresExecutor::new(pool)),
        // The column that scopes all models to a tenant (e.g. organization_id). The SDK uses this to
        // isolate test data and ensure teardown only removes records belonging to the test run.
        scope_field: "organization_id".to_string(),
        // Shared between your server and Autonoma. Used to verify incoming requests via HMAC-SHA256.
        shared_secret,
        // Private to your server only. Used to sign the refs token that tracks created records,
        // so teardown can only delete what was created.
        signing_secret,
        // Called after entity creation during `up`. Returns credentials (cookies, headers, tokens)
        // so Autonoma can make authenticated requests as the test user.
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
        // Custom create/teardown logic for models with business logic (password hashing, slug
        // generation, etc.). Models without a factory fall back to raw SQL INSERT.
        factories: Some(factories),
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
