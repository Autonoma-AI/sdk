# Autonoma SDK -- Axum + SQLx Example

A minimal Axum application using the Autonoma SDK with SQLx and PostgreSQL.

## What this example does

This example shows how to wire up the Autonoma Environment Factory endpoint in an Axum app using SQLx. The endpoint allows Autonoma to discover your schema, create test data, and tear it down.

## Prerequisites

- Rust 1.75+
- Docker (for PostgreSQL)

## Quick start

### 1. Start PostgreSQL

```bash
docker run --rm -d \
  --name autonoma-postgres \
  -e POSTGRES_USER=autonoma \
  -e POSTGRES_PASSWORD=autonoma \
  -e POSTGRES_DB=autonoma_example \
  -p 5432:5432 \
  postgres:16-alpine
```

### 2. Start the server

The app automatically creates the database tables on startup.

```bash
cargo run
```

The server will start on http://localhost:3000.

### 3. Test it

```bash
BODY='{"action":"discover"}'
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "my-shared-secret" | awk '{print $2}')

curl -X POST http://localhost:3000/api/autonoma \
  -H "Content-Type: application/json" \
  -H "x-signature: $SIGNATURE" \
  -d "$BODY"
```

### 4. Clean up

```bash
docker stop autonoma-postgres
```

## Project structure

```
├── Cargo.toml      # Rust project manifest
├── schema.sql      # PostgreSQL table definitions
├── src/
│   └── main.rs     # Axum server + Autonoma endpoint + table creation
└── README.md
```

## How it works

The key integration in `src/main.rs`:

```rust
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
    // ...
};

let app = Router::new()
    .route("/api/autonoma", post(create_axum_handler(config)));
```
