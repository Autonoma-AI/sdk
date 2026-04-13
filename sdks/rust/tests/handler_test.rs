//! Handler integration tests mirroring Python's test_handler.py.

use async_trait::async_trait;
use autonoma_sdk::handler::handle_request;
use autonoma_sdk::hmac::sign_body;
use autonoma_sdk::types::{HandlerConfig, HandlerRequest, SdkMeta, SqlExecutor};
use serde_json::Value;
use std::collections::HashMap;

struct FakeExecutor;

#[async_trait]
impl SqlExecutor for FakeExecutor {
    async fn query(
        &self,
        _sql: &str,
        _params: Option<&[Value]>,
    ) -> Result<Vec<HashMap<String, Value>>, String> {
        Ok(vec![])
    }

    async fn transaction(
        &self,
        f: Box<dyn for<'a> FnOnce(&'a dyn SqlExecutor) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> + Send>,
    ) -> Result<(), String> {
        f(self).await
    }
}

fn make_config() -> HandlerConfig {
    HandlerConfig {
        executor: Box::new(FakeExecutor),
        scope_field: "organizationId".to_string(),
        shared_secret: "shared-secret".to_string(),
        signing_secret: "signing-secret".to_string(),
        auth: Box::new(|_user, _ctx| {
            let mut map = HashMap::new();
            map.insert("token".to_string(), Value::String("test-token".to_string()));
            map
        }),
        dialect: "postgres".to_string(),
        db_schema: None,
        table_name_map: None,
        exclude_tables: None,
        allow_production: false,
        sdk: Some(SdkMeta {
            orm: "sqlx".to_string(),
            server: "actix".to_string(),
        }),
        introspection_cache: tokio::sync::OnceCell::new(),
        before_down: None,
        after_up: None,
    }
}

fn signed_request(body: &str, secret: &str) -> HandlerRequest {
    let sig = sign_body(body, secret);
    let mut headers = HashMap::new();
    headers.insert("x-signature".to_string(), sig);
    HandlerRequest {
        body: body.to_string(),
        headers,
    }
}

#[tokio::test]
async fn rejects_invalid_signature() {
    let config = make_config();
    let mut headers = HashMap::new();
    headers.insert("x-signature".to_string(), "invalid".to_string());
    let req = HandlerRequest {
        body: r#"{"action":"discover"}"#.to_string(),
        headers,
    };

    let resp = handle_request(&config, &req).await;
    assert_eq!(resp.status, 401);
    assert_eq!(resp.body["code"], "INVALID_SIGNATURE");
}

#[tokio::test]
async fn rejects_wrong_secret() {
    let config = make_config();
    let req = signed_request(r#"{"action":"discover"}"#, "wrong-secret");

    let resp = handle_request(&config, &req).await;
    assert_eq!(resp.status, 401);
    assert_eq!(resp.body["code"], "INVALID_SIGNATURE");
}

#[tokio::test]
async fn rejects_same_secrets() {
    let mut config = make_config();
    config.signing_secret = config.shared_secret.clone();
    let req = signed_request(r#"{"action":"discover"}"#, &config.shared_secret.clone());

    let resp = handle_request(&config, &req).await;
    assert_eq!(resp.status, 500);
    assert_eq!(resp.body["code"], "SAME_SECRETS");
}

#[tokio::test]
async fn rejects_unknown_action() {
    let config = make_config();
    let req = signed_request(r#"{"action":"unknown"}"#, "shared-secret");

    let resp = handle_request(&config, &req).await;
    assert_eq!(resp.status, 400);
    assert_eq!(resp.body["code"], "UNKNOWN_ACTION");
}

#[tokio::test]
async fn rejects_invalid_json() {
    let config = make_config();
    let req = signed_request("not json", "shared-secret");

    let resp = handle_request(&config, &req).await;
    assert_eq!(resp.status, 400);
    assert_eq!(resp.body["code"], "INVALID_BODY");
}

#[tokio::test]
async fn discover_returns_sdk_meta() {
    let config = make_config();
    let req = signed_request(r#"{"action":"discover"}"#, "shared-secret");

    let resp = handle_request(&config, &req).await;
    assert_eq!(resp.status, 200);
    assert_eq!(resp.body["version"], "1.0");
    assert_eq!(resp.body["sdk"]["language"], "rust");
    assert_eq!(resp.body["sdk"]["orm"], "sqlx");
    assert_eq!(resp.body["sdk"]["server"], "actix");
}
