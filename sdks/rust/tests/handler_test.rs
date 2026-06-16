//! Handler integration tests for the factory-driven SDK.

use autonoma_sdk::factory::define_factory_create_only;
use autonoma_sdk::handler::handle_request;
use autonoma_sdk::hmac::sign_body;
use autonoma_sdk::types::{
    FactoryRegistry, FieldDef, HandlerConfig, HandlerRequest, SdkMeta,
};
use serde_json::{json, Value};
use std::collections::HashMap;

fn make_config() -> HandlerConfig {
    let mut factories: FactoryRegistry = HashMap::new();
    factories.insert(
        "Organization".to_string(),
        define_factory_create_only(
            vec![FieldDef {
                name: "name".to_string(),
                field_type: "string".to_string(),
                required: true,
            }],
            |data, _ctx| {
                Box::pin(async move {
                    let mut record = serde_json::Map::new();
                    record.insert("id".into(), Value::String("org-1".into()));
                    if let Some(name) = data.get("name") {
                        record.insert("name".into(), name.clone());
                    }
                    Ok(record)
                })
            },
        ),
    );

    HandlerConfig {
        scope_field: "organizationId".to_string(),
        shared_secret: "shared-secret".to_string(),
        signing_secret: "signing-secret".to_string(),
        auth: Box::new(|_user, _ctx| {
            Box::pin(async {
                let mut map = HashMap::new();
                map.insert("token".to_string(), Value::String("test-token".to_string()));
                map
            })
        }),
        factories,
        allow_production: true,
        sdk: Some(SdkMeta {
            orm: "sqlx".to_string(),
            server: "actix".to_string(),
        }),
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
    assert_eq!(resp.body["sdk"]["language"], "rust");
    assert_eq!(resp.body["sdk"]["orm"], "sqlx");
    assert_eq!(resp.body["sdk"]["server"], "actix");
}

#[tokio::test]
async fn discover_returns_schema_from_factories() {
    let config = make_config();
    let req = signed_request(r#"{"action":"discover"}"#, "shared-secret");

    let resp = handle_request(&config, &req).await;
    assert_eq!(resp.status, 200);

    let schema = &resp.body["schema"];
    let models = schema["models"].as_array().unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0]["name"], "Organization");

    // Should have id + name fields
    let fields = models[0]["fields"].as_array().unwrap();
    assert!(fields.len() >= 2);
    assert_eq!(fields[0]["name"], "id");
    assert_eq!(fields[0]["isId"], true);

    // edges and relations should be empty
    assert_eq!(schema["edges"].as_array().unwrap().len(), 0);
    assert_eq!(schema["relations"].as_array().unwrap().len(), 0);
    assert_eq!(schema["scopeField"], "organizationId");
}

#[tokio::test]
async fn up_creates_entity_via_factory() {
    let config = make_config();
    let body = json!({
        "action": "up",
        "create": { "Organization": [{ "name": "TestOrg" }] },
        "testRunId": "run-1"
    });
    let req = signed_request(&body.to_string(), "shared-secret");

    let resp = handle_request(&config, &req).await;
    assert_eq!(resp.status, 200);
    assert_eq!(resp.body["refs"]["Organization"][0]["id"], "org-1");
    assert_eq!(resp.body["refs"]["Organization"][0]["name"], "TestOrg");
    assert!(resp.body["refsToken"].is_string());
    assert!(resp.body["auth"]["token"].is_string());
}

#[tokio::test]
async fn up_rejects_missing_factory() {
    let config = make_config();
    let body = json!({
        "action": "up",
        "create": { "UnknownModel": [{ "foo": "bar" }] },
        "testRunId": "run-nofactory"
    });
    let req = signed_request(&body.to_string(), "shared-secret");

    let resp = handle_request(&config, &req).await;
    assert_eq!(resp.status, 400);
    assert_eq!(resp.body["code"], "INVALID_BODY");
    assert!(resp.body["error"].as_str().unwrap().contains("no factory registered"));
}

#[tokio::test]
async fn blocks_when_allow_production_false() {
    let mut config = make_config();
    config.allow_production = false;
    let body = r#"{"action":"discover"}"#;
    let req = signed_request(body, "shared-secret");

    let resp = handle_request(&config, &req).await;
    assert_eq!(resp.status, 404);
    assert_eq!(resp.body["code"], "PRODUCTION_BLOCKED");
}

#[tokio::test]
async fn operates_when_allow_production_true() {
    let config = make_config(); // allow_production: true
    let body = r#"{"action":"discover"}"#;
    let req = signed_request(body, "shared-secret");

    let resp = handle_request(&config, &req).await;
    assert_eq!(resp.status, 200);
    assert!(resp.body["schema"].is_object());
}
