//! Factory integration tests for the factory-driven SDK.

use autonoma_sdk::factory::{define_factory, define_factory_create_only};
use autonoma_sdk::handler::handle_request;
use autonoma_sdk::hmac::sign_body;
use autonoma_sdk::types::{
    FactoryContext, FactoryRegistry, FieldDef, HandlerConfig, HandlerRequest, SdkMeta,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

fn teardown_fn(
    calls: Arc<Mutex<Vec<String>>>,
) -> impl for<'a> Fn(
    &'a serde_json::Map<String, Value>,
    &'a FactoryContext,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), autonoma_sdk::errors::AutonomaError>> + Send + 'a>>
       + Send
       + Sync
       + 'static {
    move |record: &serde_json::Map<String, Value>, _ctx: &FactoryContext| {
        let id_val = record.get("id").and_then(|v| v.as_str()).map(String::from);
        let calls = calls.clone();
        Box::pin(async move {
            if let Some(id) = id_val {
                calls.lock().unwrap().push(id);
            }
            Ok(())
        })
    }
}

fn make_config(factories: FactoryRegistry) -> HandlerConfig {
    HandlerConfig {
        scope_field: "organizationId".to_string(),
        shared_secret: "test-secret".to_string(),
        signing_secret: "test-signing-secret".to_string(),
        auth: Box::new(|_user, _ctx| {
            Box::pin(async {
                HashMap::from([("token".to_string(), Value::String("test-token".to_string()))])
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
async fn factory_create_returns_record() {
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
                    record.insert("id".into(), Value::String("factory-org-1".into()));
                    if let Some(name) = data.get("name") {
                        record.insert("name".into(), name.clone());
                    }
                    Ok(record)
                })
            },
        ),
    );

    let config = make_config(factories);
    let body = json!({
        "action": "up",
        "create": { "Organization": [{ "name": "FactoryOrg" }] },
        "testRunId": "run-factory"
    });
    let req = signed_request(&body.to_string(), "test-secret");
    let resp = handle_request(&config, &req).await;

    assert_eq!(resp.status, 200);
    assert_eq!(resp.body["refs"]["Organization"][0]["id"], "factory-org-1");
    assert_eq!(resp.body["refs"]["Organization"][0]["name"], "FactoryOrg");
}

#[tokio::test]
async fn factory_receives_resolved_ref_ids() {
    let received_data: Arc<Mutex<Vec<serde_json::Map<String, Value>>>> =
        Arc::new(Mutex::new(Vec::new()));
    let received_data_clone = received_data.clone();

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
                    record.insert("id".into(), Value::String("resolved-org-id".into()));
                    if let Some(name) = data.get("name") {
                        record.insert("name".into(), name.clone());
                    }
                    Ok(record)
                })
            },
        ),
    );
    factories.insert(
        "User".to_string(),
        define_factory_create_only(
            vec![
                FieldDef {
                    name: "email".to_string(),
                    field_type: "string".to_string(),
                    required: true,
                },
                FieldDef {
                    name: "name".to_string(),
                    field_type: "string".to_string(),
                    required: false,
                },
                FieldDef {
                    name: "organizationId".to_string(),
                    field_type: "string".to_string(),
                    required: false,
                },
            ],
            move |data, _ctx| {
                let captured = received_data_clone.clone();
                Box::pin(async move {
                    captured.lock().unwrap().push(data.clone());
                    let mut record = serde_json::Map::new();
                    record.insert("id".into(), Value::String("user-1".into()));
                    if let Some(email) = data.get("email") {
                        record.insert("email".into(), email.clone());
                    }
                    if let Some(org_id) = data.get("organizationId") {
                        record.insert("organizationId".into(), org_id.clone());
                    }
                    Ok(record)
                })
            },
        ),
    );

    let config = make_config(factories);
    // Use _alias/_ref to wire Organization -> User
    let body = json!({
        "action": "up",
        "create": {
            "Organization": [{ "_alias": "org1", "name": "Org" }],
            "User": [{ "email": "a@b.com", "name": "A", "organizationId": { "_ref": "org1" } }]
        },
        "testRunId": "run-ref"
    });
    let req = signed_request(&body.to_string(), "test-secret");
    let resp = handle_request(&config, &req).await;

    assert_eq!(resp.status, 200);

    let data = received_data.lock().unwrap();
    assert!(!data.is_empty(), "User factory should have been called");
    let user_data = &data[0];
    assert_eq!(
        user_data.get("organizationId"),
        Some(&Value::String("resolved-org-id".to_string())),
        "Factory should receive resolved ref ID, not temp ID"
    );
}

#[tokio::test]
async fn factory_errors_when_pk_missing() {
    let mut factories: FactoryRegistry = HashMap::new();
    factories.insert(
        "Organization".to_string(),
        define_factory_create_only(
            vec![FieldDef {
                name: "name".to_string(),
                field_type: "string".to_string(),
                required: false,
            }],
            |data, _ctx| {
                Box::pin(async move {
                    // Return record without 'id' field
                    let mut record = serde_json::Map::new();
                    if let Some(name) = data.get("name") {
                        record.insert("name".into(), name.clone());
                    }
                    Ok(record)
                })
            },
        ),
    );

    let config = make_config(factories);
    let body = json!({
        "action": "up",
        "create": { "Organization": [{ "name": "NoPK" }] },
        "testRunId": "run-nopk"
    });
    let req = signed_request(&body.to_string(), "test-secret");
    let resp = handle_request(&config, &req).await;

    assert_eq!(resp.status, 500);
    assert_eq!(resp.body["code"], "FACTORY_MISSING_PK");
}

#[tokio::test]
async fn factory_teardown_called_in_reverse_order() {
    let teardown_calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let teardown_calls_clone = teardown_calls.clone();

    let mut factories: FactoryRegistry = HashMap::new();
    factories.insert(
        "Organization".to_string(),
        define_factory(
            vec![FieldDef {
                name: "name".to_string(),
                field_type: "string".to_string(),
                required: true,
            }],
            |data, _ctx| {
                Box::pin(async move {
                    let name = data
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let mut record = serde_json::Map::new();
                    record.insert("id".into(), Value::String(format!("org-{}", name)));
                    record.insert("name".into(), Value::String(name.to_string()));
                    Ok(record)
                })
            },
            Some(teardown_fn(teardown_calls_clone)),
            None,
        ),
    );

    let config = make_config(factories);

    // Create two organizations
    let up_body = json!({
        "action": "up",
        "create": { "Organization": [{ "name": "A" }, { "name": "B" }] },
        "testRunId": "run-teardown"
    });
    let up_req = signed_request(&up_body.to_string(), "test-secret");
    let up_resp = handle_request(&config, &up_req).await;
    assert_eq!(up_resp.status, 200);

    let refs_token = up_resp.body["refsToken"].as_str().unwrap();

    // Teardown
    let down_body = json!({
        "action": "down",
        "refsToken": refs_token
    });
    let down_req = signed_request(&down_body.to_string(), "test-secret");
    let down_resp = handle_request(&config, &down_req).await;

    assert_eq!(down_resp.status, 200);

    let calls = teardown_calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    // Reverse order: B first, then A
    assert_eq!(calls[0], "org-B");
    assert_eq!(calls[1], "org-A");
}

#[tokio::test]
async fn factory_context_contains_refs() {
    let received_refs: Arc<Mutex<Option<HashMap<String, Vec<serde_json::Map<String, Value>>>>>> =
        Arc::new(Mutex::new(None));
    let received_test_run_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let refs_clone = received_refs.clone();
    let trid_clone = received_test_run_id.clone();

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
                    record.insert("id".into(), Value::String("org-ctx".into()));
                    if let Some(name) = data.get("name") {
                        record.insert("name".into(), name.clone());
                    }
                    Ok(record)
                })
            },
        ),
    );
    factories.insert(
        "User".to_string(),
        define_factory_create_only(
            vec![
                FieldDef {
                    name: "email".to_string(),
                    field_type: "string".to_string(),
                    required: true,
                },
                FieldDef {
                    name: "name".to_string(),
                    field_type: "string".to_string(),
                    required: false,
                },
                FieldDef {
                    name: "organizationId".to_string(),
                    field_type: "string".to_string(),
                    required: false,
                },
            ],
            move |data, ctx| {
                let refs_c = refs_clone.clone();
                let trid_c = trid_clone.clone();
                Box::pin(async move {
                    *refs_c.lock().unwrap() = Some(ctx.refs.clone());
                    *trid_c.lock().unwrap() = Some(ctx.test_run_id.clone());
                    let mut record = serde_json::Map::new();
                    record.insert("id".into(), Value::String("user-ctx".into()));
                    if let Some(email) = data.get("email") {
                        record.insert("email".into(), email.clone());
                    }
                    if let Some(org_id) = data.get("organizationId") {
                        record.insert("organizationId".into(), org_id.clone());
                    }
                    Ok(record)
                })
            },
        ),
    );

    let config = make_config(factories);
    let body = json!({
        "action": "up",
        "create": {
            "Organization": [{ "_alias": "org1", "name": "Org" }],
            "User": [{ "email": "x@y.com", "name": "X", "organizationId": { "_ref": "org1" } }]
        },
        "testRunId": "run-ctx"
    });
    let req = signed_request(&body.to_string(), "test-secret");
    let resp = handle_request(&config, &req).await;
    assert_eq!(resp.status, 200);

    // By the time User factory runs, Organization should already be in refs
    let refs = received_refs.lock().unwrap();
    assert!(refs.is_some(), "Factory context should contain refs");
    let refs = refs.as_ref().unwrap();
    assert!(
        refs.contains_key("Organization"),
        "Refs should contain Organization"
    );
    let orgs = &refs["Organization"];
    assert_eq!(orgs.len(), 1);
    assert_eq!(
        orgs[0].get("id"),
        Some(&Value::String("org-ctx".to_string()))
    );

    let test_run_id = received_test_run_id.lock().unwrap();
    assert_eq!(test_run_id.as_deref(), Some("run-ctx"));
}

#[tokio::test]
async fn down_without_teardown_fn_skips_gracefully() {
    let mut factories: FactoryRegistry = HashMap::new();
    factories.insert(
        "Organization".to_string(),
        define_factory_create_only(
            vec![FieldDef {
                name: "name".to_string(),
                field_type: "string".to_string(),
                required: false,
            }],
            |_data, _ctx| {
                Box::pin(async move {
                    let mut record = serde_json::Map::new();
                    record.insert("id".into(), Value::String("org-1".into()));
                    Ok(record)
                })
            },
        ),
    );

    let config = make_config(factories);

    let up_body = json!({
        "action": "up",
        "create": { "Organization": [{ "name": "Org" }] },
        "testRunId": "run-no-td"
    });
    let up_req = signed_request(&up_body.to_string(), "test-secret");
    let up_resp = handle_request(&config, &up_req).await;
    assert_eq!(up_resp.status, 200);

    let refs_token = up_resp.body["refsToken"].as_str().unwrap();
    let down_body = json!({
        "action": "down",
        "refsToken": refs_token
    });
    let down_req = signed_request(&down_body.to_string(), "test-secret");
    let down_resp = handle_request(&config, &down_req).await;

    // Should succeed (skip teardown gracefully, not error)
    assert_eq!(down_resp.status, 200);
    assert_eq!(down_resp.body["ok"], true);
}
