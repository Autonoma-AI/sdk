//! Request routing for discover / up / down protocol actions (Scenario v2).
//!
//! `discover` lists the registered scenarios; `up` looks a scenario up by name,
//! runs its free-form `up`, signs a teardown token carrying the scenario name,
//! and responds; `down` recovers the scenario name from the verified token and
//! routes to that scenario's `down`. There is no create-graph interpreter and
//! no factory-derived discover schema.

use serde_json::{json, Value};
use std::sync::Once;
use uuid::Uuid;

use crate::errors::*;
use crate::hmac::verify_signature;
use crate::refs::{sign_refs, verify_refs, RefsPayload};
use crate::scenario::Scenario;
use crate::types::{
    HandlerConfig, HandlerRequest, HandlerResponse, ScenarioDownContext, ScenarioUpContext,
};

pub const PROTOCOL_VERSION: &str = include_str!("../protocol-version.txt").trim_ascii();

const DEFAULT_EXPIRES_IN_SECONDS: u64 = 3600;

// One-shot runtime signal for users who never see the deprecation note on the
// config field.
static WARNED_DEPRECATED_ALLOW_PRODUCTION: Once = Once::new();

fn build_sdk_meta(config: &HandlerConfig) -> serde_json::Map<String, Value> {
    let sdk = config.sdk.as_ref();
    let mut map = serde_json::Map::new();
    map.insert(
        "version".to_string(),
        Value::String(PROTOCOL_VERSION.to_string()),
    );
    map.insert(
        "sdk".to_string(),
        json!({
            "language": "rust",
            "orm": sdk.map(|s| s.orm.as_str()).unwrap_or("unknown"),
            "server": sdk.map(|s| s.server.as_str()).unwrap_or("unknown"),
        }),
    );
    map
}

/// Handle an incoming Autonoma protocol request.
pub async fn handle_request(config: &HandlerConfig, req: &HandlerRequest) -> HandlerResponse {
    match handle_request_inner(config, req).await {
        Ok(resp) => resp,
        Err(e) => HandlerResponse {
            status: e.status,
            body: e.to_body(),
        },
    }
}

async fn handle_request_inner(
    config: &HandlerConfig,
    req: &HandlerRequest,
) -> Result<HandlerResponse, AutonomaError> {
    #[allow(deprecated)]
    if config.allow_production {
        WARNED_DEPRECATED_ALLOW_PRODUCTION.call_once(|| {
            eprintln!(
                "[autonoma] allow_production is deprecated and ignored - the endpoint is always enabled"
            );
        });
    }

    if config.shared_secret == config.signing_secret {
        return Err(same_secrets());
    }

    let signature = req
        .headers
        .get("x-signature")
        .or_else(|| req.headers.get("X-Signature"))
        .map(|s| s.as_str())
        .unwrap_or("");

    if !verify_signature(&req.body, signature, &config.shared_secret) {
        return Err(invalid_signature());
    }

    let body: Value = serde_json::from_str(&req.body).map_err(|_| invalid_body("invalid JSON"))?;

    let action = body.get("action").and_then(|v| v.as_str()).ok_or_else(|| {
        invalid_body("missing action. expected one of \"discover\", \"up\" or \"down\"")
    })?;

    match action {
        "discover" => handle_discover(config),
        "up" => handle_up(config, &body).await,
        "down" => handle_down(config, &body).await,
        _ => Err(unknown_action(action)),
    }
}

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

fn handle_discover(config: &HandlerConfig) -> Result<HandlerResponse, AutonomaError> {
    let scenarios: Vec<Value> = config
        .scenarios
        .iter()
        .map(|s| {
            json!({
                "name": s.name(),
                "description": s.description(),
            })
        })
        .collect();

    let mut response = build_sdk_meta(config);
    response.insert("scenarios".to_string(), Value::Array(scenarios));

    Ok(HandlerResponse {
        status: 200,
        body: Value::Object(response),
    })
}

// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------

async fn handle_up(
    config: &HandlerConfig,
    body: &Value,
) -> Result<HandlerResponse, AutonomaError> {
    let name = read_scenario_name(body)
        .ok_or_else(|| invalid_body("missing \"scenario.name\" in request body"))?;

    let scenario = find_scenario(config, &name).ok_or_else(|| unknown_environment(&name))?;

    let test_run_id = body
        .get("testRunId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let result = scenario
        .up(&ScenarioUpContext {
            test_run_id: test_run_id.clone(),
        })
        .await?;

    let teardown = result.teardown.clone().unwrap_or_else(|| json!({}));
    let teardown_token = sign_refs(
        &RefsPayload {
            refs: teardown,
            test_run_id: test_run_id.clone(),
            environment: name.clone(),
        },
        &config.signing_secret,
    );

    let expires_in_seconds = config
        .expires_in_seconds
        .unwrap_or(DEFAULT_EXPIRES_IN_SECONDS);

    let mut response = build_sdk_meta(config);
    if let Some(auth) = &result.auth {
        response.insert(
            "auth".to_string(),
            serde_json::to_value(auth).unwrap_or(Value::Null),
        );
    }
    response.insert("teardownToken".to_string(), Value::String(teardown_token));
    response.insert(
        "expiresInSeconds".to_string(),
        Value::Number(expires_in_seconds.into()),
    );

    Ok(HandlerResponse {
        status: 200,
        body: Value::Object(response),
    })
}

// ---------------------------------------------------------------------------
// down
// ---------------------------------------------------------------------------

async fn handle_down(
    config: &HandlerConfig,
    body: &Value,
) -> Result<HandlerResponse, AutonomaError> {
    let teardown_token = body
        .get("teardownToken")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid_body("missing teardownToken"))?;

    let payload = verify_refs(teardown_token, &config.signing_secret)
        .map_err(|e| invalid_teardown_token(&e))?;

    let test_run_id = payload.test_run_id;

    // The verified token is authoritative for routing; any scenario name on the
    // request body is ignored.
    let name = payload.environment;

    if !name.is_empty() {
        if let Some(scenario) = find_scenario(config, &name) {
            scenario
                .down(&ScenarioDownContext {
                    name: name.clone(),
                    teardown: payload.refs,
                    test_run_id,
                })
                .await?;
        }
    }

    let mut response = build_sdk_meta(config);
    response.insert("ok".to_string(), Value::Bool(true));

    Ok(HandlerResponse {
        status: 200,
        body: Value::Object(response),
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn find_scenario<'a>(config: &'a HandlerConfig, name: &str) -> Option<&'a dyn Scenario> {
    config
        .scenarios
        .iter()
        .find(|s| s.name() == name)
        .map(|s| s.as_ref())
}

/// Read `body.scenario.name` from an untrusted JSON body.
fn read_scenario_name(body: &Value) -> Option<String> {
    body.get("scenario")?
        .as_object()?
        .get("name")?
        .as_str()
        .map(String::from)
}
