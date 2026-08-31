//! Handler integration tests for the Scenario v2 SDK.

use autonoma_sdk::errors::AutonomaError;
use autonoma_sdk::handler::handle_request;
use autonoma_sdk::hmac::sign_body;
use autonoma_sdk::scenario::{define_scenario, define_scenario_up_only, Scenario};
use autonoma_sdk::types::{
    AuthResult, HandlerConfig, HandlerRequest, ScenarioDownContext, ScenarioUpContext,
    ScenarioUpResult,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

// --- Scenarios ---

fn standard_up(
    ctx: &ScenarioUpContext,
) -> Pin<Box<dyn Future<Output = Result<ScenarioUpResult, AutonomaError>> + Send + '_>> {
    let test_run_id = ctx.test_run_id.clone();
    Box::pin(async move {
        let mut headers = HashMap::new();
        headers.insert(
            "Authorization".to_string(),
            format!("Bearer {}", test_run_id),
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

fn recording_down(
    calls: Arc<Mutex<Vec<String>>>,
) -> impl for<'a> Fn(
    &'a ScenarioDownContext,
) -> Pin<Box<dyn Future<Output = Result<(), AutonomaError>> + Send + 'a>>
       + Send
       + Sync
       + 'static {
    move |ctx: &ScenarioDownContext| {
        let entry = format!("{}:{}", ctx.name, ctx.test_run_id);
        let calls = calls.clone();
        Box::pin(async move {
            calls.lock().unwrap().push(entry);
            Ok(())
        })
    }
}

fn test_scenarios(down_calls: Option<Arc<Mutex<Vec<String>>>>) -> Vec<Box<dyn Scenario>> {
    let standard = match down_calls {
        Some(calls) => define_scenario(
            "standard",
            "A standard seeded environment",
            standard_up,
            Some(recording_down(calls)),
        ),
        None => define_scenario_up_only("standard", "A standard seeded environment", standard_up),
    };
    vec![
        standard,
        define_scenario_up_only("empty", "Nothing seeded", |_ctx| {
            Box::pin(async move { Ok(ScenarioUpResult::default()) })
        }),
    ]
}

#[allow(deprecated)]
fn base_config(down_calls: Option<Arc<Mutex<Vec<String>>>>) -> HandlerConfig {
    HandlerConfig {
        shared_secret: "shared".to_string(),
        signing_secret: "signing".to_string(),
        scenarios: test_scenarios(down_calls),
        expires_in_seconds: None,
        allow_production: false,
        sdk: None,
    }
}

fn signed_req(body: &Value, secret: &str) -> HandlerRequest {
    signed_req_raw(&body.to_string(), secret)
}

fn signed_req_raw(body: &str, secret: &str) -> HandlerRequest {
    let mut headers = HashMap::new();
    headers.insert("x-signature".to_string(), sign_body(body, secret));
    HandlerRequest {
        body: body.to_string(),
        headers,
    }
}

// --- Request gate ---

#[tokio::test]
async fn rejects_invalid_signature() {
    let req = HandlerRequest {
        body: r#"{"action":"discover"}"#.to_string(),
        headers: HashMap::from([("x-signature".to_string(), "invalid".to_string())]),
    };
    let resp = handle_request(&base_config(None), &req).await;
    assert_eq!(resp.status, 401);
    assert_eq!(resp.body["code"], "INVALID_SIGNATURE");
}

#[tokio::test]
async fn rejects_same_secrets() {
    #[allow(deprecated)]
    let config = HandlerConfig {
        shared_secret: "same".to_string(),
        signing_secret: "same".to_string(),
        scenarios: vec![],
        expires_in_seconds: None,
        allow_production: false,
        sdk: None,
    };
    let req = HandlerRequest {
        body: r#"{"action":"discover"}"#.to_string(),
        headers: HashMap::from([("x-signature".to_string(), "x".to_string())]),
    };
    let resp = handle_request(&config, &req).await;
    assert_eq!(resp.status, 500);
    assert_eq!(resp.body["code"], "SAME_SECRETS");
}

#[tokio::test]
async fn rejects_invalid_body() {
    let resp = handle_request(&base_config(None), &signed_req_raw("not json", "shared")).await;
    assert_eq!(resp.status, 400);
    assert_eq!(resp.body["code"], "INVALID_BODY");
}

#[tokio::test]
async fn rejects_unknown_action() {
    let req = signed_req(&json!({ "action": "nonexistent" }), "shared");
    let resp = handle_request(&base_config(None), &req).await;
    assert_eq!(resp.status, 400);
    assert_eq!(resp.body["code"], "UNKNOWN_ACTION");
}

// --- discover ---

#[tokio::test]
async fn discover_lists_scenarios() {
    let req = signed_req(&json!({ "action": "discover" }), "shared");
    let resp = handle_request(&base_config(None), &req).await;
    assert_eq!(resp.status, 200);
    assert_eq!(resp.body["version"], "2.0");

    let scenarios = resp.body["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), 2);
    assert_eq!(scenarios[0]["name"], "standard");
    assert!(!scenarios[0]["description"].as_str().unwrap().is_empty());

    // discover must never leak a create/schema shape in v2.
    assert!(resp.body.get("schema").is_none());
}

// --- up ---

#[tokio::test]
async fn up_returns_envelope() {
    let body = json!({ "action": "up", "scenario": { "name": "standard" }, "testRunId": "run-1" });
    let resp = handle_request(&base_config(None), &signed_req(&body, "shared")).await;
    assert_eq!(resp.status, 200);
    assert_eq!(resp.body["version"], "2.0");

    let token = resp.body["teardownToken"].as_str().unwrap();
    assert_eq!(token.split('.').count(), 3);
    assert_eq!(resp.body["expiresInSeconds"], 3600);
    assert_eq!(resp.body["auth"]["headers"]["Authorization"], "Bearer run-1");
    // The duplicated plaintext refs and the old refsToken field are gone.
    assert!(resp.body.get("refs").is_none());
    assert!(resp.body.get("refsToken").is_none());
}

#[tokio::test]
async fn up_custom_expires() {
    let mut config = base_config(None);
    config.expires_in_seconds = Some(60);
    let body = json!({ "action": "up", "scenario": { "name": "empty" }, "testRunId": "r" });
    let resp = handle_request(&config, &signed_req(&body, "shared")).await;
    assert_eq!(resp.body["expiresInSeconds"], 60);
    // The empty scenario returns nothing, so no auth on the envelope.
    assert!(resp.body.get("auth").is_none());
}

#[tokio::test]
async fn up_unknown_environment() {
    let body = json!({ "action": "up", "scenario": { "name": "does-not-exist" }, "testRunId": "r" });
    let resp = handle_request(&base_config(None), &signed_req(&body, "shared")).await;
    assert_eq!(resp.status, 400);
    assert_eq!(resp.body["code"], "UNKNOWN_ENVIRONMENT");
}

#[tokio::test]
async fn up_missing_scenario_name() {
    let body = json!({ "action": "up", "testRunId": "r" });
    let resp = handle_request(&base_config(None), &signed_req(&body, "shared")).await;
    assert_eq!(resp.status, 400);
    assert_eq!(resp.body["code"], "INVALID_BODY");
}


// --- down ---

#[tokio::test]
async fn down_valid_token() {
    let down_calls = Arc::new(Mutex::new(Vec::new()));
    let config = base_config(Some(down_calls.clone()));

    let up_body = json!({ "action": "up", "scenario": { "name": "standard" }, "testRunId": "run-td" });
    let up_resp = handle_request(&config, &signed_req(&up_body, "shared")).await;
    let token = up_resp.body["teardownToken"].as_str().unwrap().to_string();

    let down_body = json!({ "action": "down", "teardownToken": token, "testRunId": "run-td" });
    let down_resp = handle_request(&config, &signed_req(&down_body, "shared")).await;
    assert_eq!(down_resp.status, 200);
    assert_eq!(down_resp.body["ok"], true);

    let calls = down_calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0], "standard:run-td");
}

#[tokio::test]
async fn down_routes_by_token_environment() {
    let down_calls = Arc::new(Mutex::new(Vec::new()));
    let config = base_config(Some(down_calls.clone()));

    let up_body = json!({ "action": "up", "scenario": { "name": "standard" }, "testRunId": "run-tok" });
    let token = handle_request(&config, &signed_req(&up_body, "shared"))
        .await
        .body["teardownToken"]
        .as_str()
        .unwrap()
        .to_string();

    // No scenario.name on the down request - the handler must recover it from
    // the verified token's environment.
    let down_body = json!({ "action": "down", "teardownToken": token });
    let down_resp = handle_request(&config, &signed_req(&down_body, "shared")).await;
    assert_eq!(down_resp.status, 200);

    let calls = down_calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0], "standard:run-tok");
}

#[tokio::test]
async fn down_invalid_teardown_token() {
    let body = json!({ "action": "down", "teardownToken": "tampered.token.value" });
    let resp = handle_request(&base_config(None), &signed_req(&body, "shared")).await;
    assert_eq!(resp.status, 403);
    assert_eq!(resp.body["code"], "INVALID_TEARDOWN_TOKEN");
}

#[tokio::test]
async fn down_missing_teardown_token() {
    let body = json!({ "action": "down" });
    let resp = handle_request(&base_config(None), &signed_req(&body, "shared")).await;
    assert_eq!(resp.status, 400);
    assert_eq!(resp.body["code"], "INVALID_BODY");
}

#[tokio::test]
async fn endpoint_always_enabled() {
    // allow_production is a deprecated no-op: discover serves regardless.
    let req = signed_req(&json!({ "action": "discover" }), "shared");
    let resp = handle_request(&base_config(None), &req).await;
    assert_eq!(resp.status, 200);
}
