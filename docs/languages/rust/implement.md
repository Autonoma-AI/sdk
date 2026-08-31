# Implement the endpoint (Rust)

Follow these steps to stand up a working Environment Factory endpoint. This is written for a coding agent doing the integration; do the steps in order and do not skip the validation step.

## Prerequisites

- A Rust backend on Axum or Actix Web, running on a `tokio` runtime.
- The database client your app already uses (`sqlx`, `diesel`, `tokio-postgres` - it does not matter; your scenario code calls it). A connection pool you can capture into a closure, typically an `Arc<Pool>`.

## Step 1 - Add the crate and enable a server feature

The crate is `autonoma-sdk` (imported as `autonoma_sdk`). The server adapters are **behind Cargo features**, and the default is neither - you must opt in to exactly the one that matches your framework.

| Framework | Feature | Adapter module | Handler function |
|-----------|---------|----------------|------------------|
| Axum | `axum` | `autonoma_sdk::axum` | `create_axum_handler` |
| Actix Web | `actix` | `autonoma_sdk::actix` | `create_actix_handler` |

```toml
# Cargo.toml
[dependencies]
autonoma-sdk = { version = "2", features = ["axum"] }   # or features = ["actix"]
```

There is no ORM feature and no database dependency on this crate - it never touches your database. The only features are `actix` and `axum` (`sdks/rust/Cargo.toml`). Build and test the crate with `cargo build && cargo test`.

## Step 2 - Generate the two secrets

```bash
# shell
openssl rand -hex 32   # AUTONOMA_SHARED_SECRET
openssl rand -hex 32   # AUTONOMA_SIGNING_SECRET  (must be different)
```

Add both to your environment. The SDK returns `SAME_SECRETS` (HTTP 500) if they match (`sdks/rust/src/handler.rs`).

## Step 3 - Confirm the endpoint path and auth mechanism

There is no scope field to find in v2. Instead, confirm two things with the user before writing code:

- The endpoint path you will mount (for example `/api/autonoma`).
- How the app authenticates a request (session cookie, JWT bearer, or email + password), so your scenarios' `up` can return real, working credentials.

## Step 4 - Write scenarios

A scenario is named code that provisions an environment. The idiomatic surface is the `Scenario` trait, but the fastest way to register one inline is the closure helper `define_scenario` (with an `up` and a `down`) or `define_scenario_up_only` (no `down`); both return `Box<dyn Scenario>`. Each `up`/`down` is a function whose body is `Box::pin(async move { ... })` and whose return type spells out the boxed future. `up` returns `Result<ScenarioUpResult, AutonomaError>`; `down` returns `Result<(), AutonomaError>`. See `scenarios.md` for the authoring rules.

`ScenarioUpContext` carries one field, `test_run_id`. `ScenarioUpResult` (derives `Default`) has two optional fields: `auth: Option<AuthResult>`, `teardown: Option<serde_json::Value>`.

```rust
// src/scenarios.rs
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use autonoma_sdk::errors::AutonomaError;
use autonoma_sdk::scenario::{define_scenario, define_scenario_up_only, Scenario};
use autonoma_sdk::types::{AuthResult, ScenarioDownContext, ScenarioUpContext, ScenarioUpResult};
use autonoma_sdk::unique::unique_email;
use serde_json::json;

fn single_user_up(
    ctx: &ScenarioUpContext,
) -> Pin<Box<dyn Future<Output = Result<ScenarioUpResult, AutonomaError>> + Send + '_>> {
    let test_run_id = ctx.test_run_id.clone();
    Box::pin(async move {
        let _email = unique_email(&test_run_id, "", "");
        // ... your real creation + session code goes here ...
        let user_id = format!("user-{}", test_run_id);
        let token = format!("token-{}", test_run_id);

        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), format!("Bearer {token}"));

        Ok(ScenarioUpResult {
            auth: Some(AuthResult {
                headers: Some(headers),
                ..Default::default()
            }),
            teardown: Some(json!({ "userId": user_id })),
        })
    })
}

fn single_user_down(
    ctx: &ScenarioDownContext,
) -> Pin<Box<dyn Future<Output = Result<(), AutonomaError>> + Send + '_>> {
    let teardown = ctx.teardown.clone();
    Box::pin(async move {
        let _user_id = teardown.get("userId").and_then(|v| v.as_str());
        // ... delete exactly what up created ...
        Ok(())
    })
}

fn empty_up(
    _ctx: &ScenarioUpContext,
) -> Pin<Box<dyn Future<Output = Result<ScenarioUpResult, AutonomaError>> + Send + '_>> {
    Box::pin(async move { Ok(ScenarioUpResult::default()) })
}

pub fn scenarios() -> Vec<Box<dyn Scenario>> {
    vec![
        define_scenario(
            "single-user",
            "One verified user in a fresh org",
            single_user_up,
            Some(single_user_down),
        ),
        define_scenario_up_only("empty", "An empty org with one user, nothing else", empty_up),
    ]
}
```

`define_scenario` panics at process start on an empty `name`, since an invalid scenario is a programming error. If you prefer, you can `impl Scenario for MyStruct` directly (using `#[async_trait]`) instead of the closure helpers - the handler stores `Box<dyn Scenario>` either way.

## Step 5 - Wire the handler

Build a `HandlerConfig` once and hand it to your adapter's handler function. The config carries the two secrets and the scenario `Vec`. There is **no** `scope_field`, **no** `factories`, and **no** top-level `auth` callback.

`allow_production` is deprecated and ignored, but it is still a required struct field - set it to `false` and put `#[allow(deprecated)]` on the construction so the compiler stays quiet.

```rust
// src/main.rs  (Axum)
use axum::routing::post;
use axum::Router;
use autonoma_sdk::axum::create_axum_handler;
use autonoma_sdk::types::HandlerConfig;
use crate::scenarios::scenarios;

#[allow(deprecated)]
let config = HandlerConfig {
    shared_secret: std::env::var("AUTONOMA_SHARED_SECRET").expect("AUTONOMA_SHARED_SECRET"),
    signing_secret: std::env::var("AUTONOMA_SIGNING_SECRET").expect("AUTONOMA_SIGNING_SECRET"),
    scenarios: scenarios(),
    expires_in_seconds: None,  // default 3600 (one hour)
    allow_production: false,   // deprecated no-op; struct still requires it
    sdk: None,                 // the adapter fills in language/server
};

let app = Router::new()
    .route("/api/autonoma", post(create_axum_handler(config)));
```

Actix Web uses the same config; only the mounting differs:

```rust
// src/main.rs  (Actix Web)
use actix_web::{web, App, HttpServer};
use autonoma_sdk::actix::create_actix_handler;

HttpServer::new(move || {
    let config = build_config();  // same #[allow(deprecated)] HandlerConfig as above
    App::new().route("/api/autonoma", web::post().to(create_actix_handler(config)))
})
.bind(("0.0.0.0", 3000))?
.run()
.await
```

`create_axum_handler` (`sdks/rust/src/axum.rs`) and `create_actix_handler` (`sdks/rust/src/actix.rs`) wrap the config in an `Arc` internally, set `sdk.server`, read the raw body as bytes (required for HMAC), and call `handle_request` for you. The returned Axum handler is `Clone` and safe to share across requests. Standalone variants (`axum_handler`, `actix_handler`) exist if you route manually.

## Step 6 - Return real credentials from `up`

The `auth` a scenario's `up` returns is the part that most often breaks tests, so get it right. It must be **real, working credentials** produced by the app's actual auth mechanism. A fake or hardcoded token makes every test fail at login. `AuthResult` has three optional fields - `cookies: Option<Vec<AuthCookie>>`, `headers: Option<HashMap<String, String>>`, `credentials: Option<HashMap<String, String>>` - and derives `Default`, so fill only the one your app uses. There is no top-level `token` field.

```rust
// Session cookie (most web apps)
use autonoma_sdk::types::{AuthCookie, AuthResult};
let auth = AuthResult {
    cookies: Some(vec![AuthCookie {
        name: "session".to_string(),
        value: token,
        http_only: Some(true),
        same_site: Some("lax".to_string()),
        path: Some("/".to_string()),
        ..Default::default()
    }]),
    ..Default::default()
};

// JWT bearer token (APIs, SPAs) - the token goes in a header
let mut headers = HashMap::new();
headers.insert("Authorization".to_string(), format!("Bearer {token}"));
let auth = AuthResult { headers: Some(headers), ..Default::default() };

// Email + password (the runner logs in through the UI, e.g. mobile)
let mut creds = HashMap::new();
creds.insert("email".to_string(), email.clone());
creds.insert("password".to_string(), "test-password-123".to_string());
let auth = AuthResult { credentials: Some(creds), ..Default::default() };
```

For the email/password shape, the scenario must create the user with a matching password hash so a real login succeeds.

## Step 7 - Production gating (optional)

The endpoint is always enabled - HMAC signing is the gate, and unsigned requests get `401`. The old `allow_production` field is deprecated and ignored (the handler logs a one-shot warning if you set it `true`, then does nothing). On Autonoma preview environments (`AUTONOMA_PREVIEWKIT` is set) nothing more is needed - previews are isolated and never production. If you deploy the factory in your own environments and want it dark in production anyway, gate the route registration with your own condition:

```rust
// src/main.rs
let mut app = Router::new();
if std::env::var("APP_ENV").as_deref() != Ok("production") {
    app = app.route("/api/autonoma", post(create_axum_handler(config)));
}
```

## Step 8 - Validate before deploying

There is no `check_scenario` helper in the Rust SDK. Dry-run each scenario by driving `handle_request` through a full `up` then `down` cycle in a `#[tokio::test]` against a real (test) database, signing the body with `hmac::sign_body`, and iterate until it passes. See `validation.md`. Never ship a scenario you have not validated.

## Step 9 - Smoke-test with curl

The signature is the HMAC-SHA256 of the raw body, keyed with the shared secret, as hex, in the `x-signature` header.

```bash
# shell
SECRET="your-shared-secret"
BODY='{"action":"discover"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/.*= //')
curl -s -X POST http://localhost:3000/api/autonoma \
  -H "Content-Type: application/json" -H "x-signature: $SIG" -d "$BODY" | jq .
```

Expected: a JSON body listing your scenarios as `{ name, description }`, plus the `version` and `sdk` metadata. A `404` means the route is not mounted; a `401` means the secret does not match.

## Step 10 - Report and connect

Tell the user the endpoint path, confirm all scenarios pass, and hand off:

1. Set `AUTONOMA_SHARED_SECRET` and `AUTONOMA_SIGNING_SECRET` in staging/production env.
2. Deploy the endpoint.
3. Paste `AUTONOMA_SHARED_SECRET` into the Autonoma dashboard when connecting the app.

## Rules

**Do:**
- Reuse the app's existing DB client and real creation code inside `up` (capture an `Arc<Pool>` in the closure or store it on your `Scenario` struct).
- Return real credentials from `auth` using the app's own session/JWT logic.
- Seed every unique value from `test_run_id` with the `unique_*` helpers.
- Match the project's conventions: module layout, error handling, naming.
- Validate every scenario with a `#[tokio::test]` before deploying.

**Do not:**
- Implement HMAC, token signing, or expiry yourself - the SDK owns all of it.
- Return a hardcoded token like `"test-token"` from `auth`.
- Use the same value for `shared_secret` and `signing_secret`.
- Reach for a random UUID or wall-clock time for a unique value - it breaks the determinism `down` and debugging rely on.
- Add a `sqlx` (or any ORM) feature to the crate - it has none; only `actix` and `axum` exist.
