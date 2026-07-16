# Implement the endpoint (Rust)

Follow these steps to stand up a working Environment Factory endpoint. This is written for a coding agent doing the integration; do the steps in order and do not skip the validation step.

## Prerequisites

- A Rust backend on Actix Web or Axum, running on a `tokio` runtime.
- The database client your app already uses (`sqlx`, `diesel`, `tokio-postgres` - it does not matter; your factories call it). Have a connection pool you can share, typically an `Arc<Pool>`.

## Step 1 - Add the crate with the right feature

The crate is `autonoma-sdk`. Enable exactly one server-adapter feature that matches your framework:

| Framework | Feature | Adapter module |
|-----------|---------|----------------|
| Axum | `axum` | `autonoma_sdk::axum` |
| Actix Web | `actix` | `autonoma_sdk::actix` |

```toml
# Cargo.toml
[dependencies]
autonoma-sdk = { version = "0.1", features = ["axum"] }   # or features = ["actix"]
```

The crate name uses a hyphen; import it as `autonoma_sdk`. There are no `sqlx` feature flags on this crate - it never touches your database. The only features are `actix` and `axum` (`sdks/rust/Cargo.toml`).

## Step 2 - Generate the two secrets

```bash
# shell
openssl rand -hex 32   # AUTONOMA_SHARED_SECRET
openssl rand -hex 32   # AUTONOMA_SIGNING_SECRET  (must be different)
```

Add both to your environment. The SDK returns `SAME_SECRETS` (HTTP 500) if they match (`sdks/rust/src/handler.rs:54`).

## Step 3 - Find the scope field

Read the database schema. Find the foreign key that appears on the most models and points at a single root entity - commonly `organizationId`, `orgId`, `tenantId`, or `workspaceId`. That is the scope field. The root model itself (e.g. `Organization`) does not carry it.

Confirm the field, the endpoint path, and the app's auth mechanism with the user before writing code.

## Step 4 - Write a factory per model

Write one factory for each model the platform will create, calling your app's real creation code, and collect them into a `FactoryRegistry` (a `HashMap<String, FactoryDefinition>`). See `factories.md` for the full contract.

## Step 5 - Build the handler config

`HandlerConfig` (`sdks/rust/src/types.rs:187`) carries the scope field, both secrets, the factory registry, the gate flag, and the auth callback. Build it once and hand it to your adapter.

```rust
// src/autonoma.rs
use std::collections::HashMap;
use std::sync::Arc;
use serde_json::{json, Value, Map};
use sqlx::PgPool;
use autonoma_sdk::types::{AuthContext, HandlerConfig};
use crate::factories::build_factories;

pub fn autonoma_config(pool: Arc<PgPool>) -> HandlerConfig {
    HandlerConfig {
        scope_field: "organizationId".into(),
        shared_secret: std::env::var("AUTONOMA_SHARED_SECRET").unwrap(),
        signing_secret: std::env::var("AUTONOMA_SIGNING_SECRET").unwrap(),
        factories: build_factories(pool.clone()),
        allow_production: true,   // see Step 7
        auth: Box::new(move |user: Option<&Map<String, Value>>, _ctx: &AuthContext| {
            let pool = pool.clone();
            let user = user.cloned();
            Box::pin(async move {
                let id = user.as_ref().and_then(|u| u["id"].as_str()).unwrap();
                let token = create_session(&pool, id).await;   // your real session code
                let mut out: HashMap<String, Value> = HashMap::new();
                out.insert("cookies".into(), json!([{
                    "name": "session", "value": token,
                    "httpOnly": true, "sameSite": "lax", "path": "/"
                }]));
                out
            })
        }),
        sdk: None,          // the adapter fills in language/server
        before_down: None,
        after_up: None,
    }
}
```

## Step 6 - Wire the handler

Both adapters take the config and return a closure you mount on your router. The adapter reads the raw body as bytes (required for HMAC), sets `sdk.server`, and calls `handle_request` for you.

```rust
// src/main.rs  (Axum)
use axum::{routing::post, Router};
use autonoma_sdk::axum::create_axum_handler;

let config = autonoma_config(pool.clone());
let app = Router::new()
    .route("/api/autonoma", post(create_axum_handler(config)));
```

```rust
// src/main.rs  (Actix Web)
use actix_web::{web, App, HttpServer};
use autonoma_sdk::actix::create_actix_handler;

HttpServer::new(move || {
    let config = autonoma_config(pool.clone());
    App::new().route("/api/autonoma", web::post().to(create_actix_handler(config)))
})
.bind(("0.0.0.0", 3000))?
.run()
.await
```

`create_axum_handler` (`sdks/rust/src/axum.rs:28`) and `create_actix_handler` (`sdks/rust/src/actix.rs:26`) wrap the config in an `Arc` internally, so the returned handler is `Clone` and safe to share across requests. Standalone variants (`axum_handler`, `actix_handler`) exist if you route manually.

## Step 7 - Implement the auth callback

This is the part that most often breaks tests, so get it right. The callback signature is:

```rust
// signature (from sdks/rust/src/types.rs:191)
Fn(Option<&Map<String, Value>>, &AuthContext)
    -> Pin<Box<dyn Future<Output = HashMap<String, Value>> + Send>>
```

- The first argument is the first created `User` record (case-insensitive on the model name `user`/`users`), or `None` if the scenario made none (`sdks/rust/src/handler.rs:478`).
- `AuthContext` is `{ scope_value: &str, refs: &HashMap<...> }` (`sdks/rust/src/types.rs:171`).
- It returns a `HashMap<String, Value>` that the SDK places verbatim under the response's `auth` field. There is **no top-level `token`** - populate the map with `cookies`, `headers`, and/or `credentials` to match how the platform logs in. A bearer token goes inside `headers`.

Return **real, working credentials** from your app's actual auth mechanism. A fake or hardcoded token makes every test fail at login. Pick the shape that matches your app:

```rust
// src/autonoma.rs - session cookie (most web apps)
out.insert("cookies".into(), json!([{ "name": "session", "value": token, "httpOnly": true }]));

// JWT bearer token (APIs, SPAs) - token goes in a header
out.insert("headers".into(), json!({ "Authorization": format!("Bearer {token}") }));

// email + password (the runner logs in through the UI, e.g. mobile)
out.insert("credentials".into(), json!({ "email": email, "password": "test-password-123" }));
```

For the email/password shape, the `User` factory must create the record with a matching password hash so a real login succeeds.

## Step 8 - Enable the endpoint

The endpoint returns `404 PRODUCTION_BLOCKED` until `allow_production` is `true` (`sdks/rust/src/handler.rs:58`). The SDK never inspects an environment variable - this flag is the only switch, so you own the condition:

```rust
// src/autonoma.rs
allow_production: true,                                        // always on
allow_production: std::env::var("APP_ENV").as_deref() != Ok("production"),  // off in prod
```

## Step 9 - Validate before deploying

There is no `check_scenario` helper in the Rust SDK. Dry-run each scenario by driving `handle_request` through an `up` then `down` cycle in a `#[tokio::test]` against a real (test) database, and iterate until it passes. See `validation.md`. Never ship a scenario you have not validated.

## Step 10 - Smoke-test with curl

The signature is the HMAC-SHA256 of the raw body, keyed with the shared secret, as hex, in the `x-signature` header.

```bash
# shell
SECRET="your-shared-secret"
BODY='{"action":"discover"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/.*= //')
curl -s -X POST http://localhost:3000/api/autonoma \
  -H "Content-Type: application/json" -H "x-signature: $SIG" -d "$BODY" | jq .
```

Expected: a JSON schema listing your models and `scopeField`. A `404` means `allow_production` is not `true` or the route is not mounted; a `401` means the secret does not match.

## Step 11 - Report and connect

Tell the user the endpoint path, confirm all scenarios pass, and hand off:

1. Set `AUTONOMA_SHARED_SECRET` and `AUTONOMA_SIGNING_SECRET` in staging/production env.
2. Deploy the endpoint.
3. Paste `AUTONOMA_SHARED_SECRET` into the Autonoma dashboard when connecting the app.

## Rules

**Do:**
- Reuse the app's existing DB pool and real creation code inside factories (capture an `Arc<Pool>` in the closure).
- Return real credentials from `auth` using the app's own session/JWT logic.
- Register a factory (with a teardown) for every model any scenario creates.
- Match the project's conventions: module layout, error handling, naming.
- Validate every scenario with a `#[tokio::test]` before deploying.

**Do not:**
- Implement HMAC, token signing, or teardown ordering yourself - the SDK owns all of it.
- Return a hardcoded token like `"test-token"` from `auth`.
- Use the same value for `shared_secret` and `signing_secret`.
- Set `id`, defaulted fields, or auto timestamps in scenario data.
- Expect the SDK to inject the scope field or wire any FK - you set every FK as a `_ref`.
- Add a `sqlx` feature to the crate - it has none; only `actix` and `axum` exist.
