// Minimal Axum server that runs the Rust SDK's v2 handler with a couple of
// scenarios. Used by run-suites.mjs to exercise the shared protocol/suites/*
// against a real Rust endpoint. It mirrors protocol/servers/go-server.go.
//
// Built as the `protocol-server` binary of the autonoma-sdk crate (see its
// Cargo.toml), so it lives outside src/ but compiles against the crate.

#[cfg(feature = "axum")]
mod server {
    use std::collections::HashMap;
    use std::env;
    use std::future::Future;
    use std::net::SocketAddr;
    use std::pin::Pin;

    use autonoma_sdk::axum::create_axum_handler;
    use autonoma_sdk::errors::AutonomaError;
    use autonoma_sdk::scenario::{define_scenario, define_scenario_up_only};
    use autonoma_sdk::types::{
        AuthResult, HandlerConfig, ScenarioDownContext, ScenarioUpContext, ScenarioUpResult,
        SdkMeta,
    };
    use axum::routing::post;
    use axum::Router;
    use serde_json::json;

    fn standard_up(
        ctx: &ScenarioUpContext,
    ) -> Pin<Box<dyn Future<Output = Result<ScenarioUpResult, AutonomaError>> + Send + '_>> {
        let test_run_id = ctx.test_run_id.clone();
        Box::pin(async move {
            let mut headers = HashMap::new();
            headers.insert(
                "Authorization".to_string(),
                format!("Bearer token-{}", test_run_id),
            );
            Ok(ScenarioUpResult {
                auth: Some(AuthResult {
                    headers: Some(headers),
                    ..Default::default()
                }),
                teardown: Some(json!({ "userId": format!("user-{}", test_run_id) })),
            })
        })
    }

    fn noop_down(
        _ctx: &ScenarioDownContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), AutonomaError>> + Send + '_>> {
        Box::pin(async move { Ok(()) })
    }

    fn empty_up(
        _ctx: &ScenarioUpContext,
    ) -> Pin<Box<dyn Future<Output = Result<ScenarioUpResult, AutonomaError>> + Send + '_>> {
        Box::pin(async move { Ok(ScenarioUpResult::default()) })
    }

    pub async fn run() {
        let shared_secret =
            env::var("AUTONOMA_SHARED_SECRET").unwrap_or_else(|_| "protocol-shared".to_string());
        let signing_secret =
            env::var("AUTONOMA_SIGNING_SECRET").unwrap_or_else(|_| "protocol-signing".to_string());
        let port: u16 = env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(4596);

        #[allow(deprecated)]
        let config = HandlerConfig {
            shared_secret,
            signing_secret,
            sdk: Some(SdkMeta {
                orm: "none".to_string(),
                server: "axum".to_string(),
            }),
            expires_in_seconds: None,
            allow_production: false,
            scenarios: vec![
                define_scenario(
                    "standard",
                    "A standard seeded environment",
                    standard_up,
                    Some(noop_down),
                ),
                define_scenario_up_only("empty", "Nothing seeded", empty_up),
            ],
        };

        let app = Router::new().route("/", post(create_axum_handler(config)));

        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        println!("rust-server listening on {}", port);
        axum::serve(listener, app).await.unwrap();
    }
}

#[cfg(feature = "axum")]
#[tokio::main]
async fn main() {
    server::run().await;
}

#[cfg(not(feature = "axum"))]
fn main() {
    eprintln!("rust-server requires the `axum` feature: build with --features axum");
    std::process::exit(1);
}
