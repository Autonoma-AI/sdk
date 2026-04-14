//! Factory integration tests mirroring TypeScript's factory test suite.

use async_trait::async_trait;
use autonoma_sdk::errors::AutonomaError;
use autonoma_sdk::handler::handle_request;
use autonoma_sdk::hmac::sign_body;
use autonoma_sdk::types::{
    Factory, FactoryContext, FactoryRegistry, HandlerConfig, HandlerRequest, SdkMeta, SqlExecutor,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Mock executor that handles introspection queries and tracks SQL calls.
struct MockExecutor {
    queries: Arc<Mutex<Vec<String>>>,
    insert_counter: Arc<Mutex<u32>>,
}

impl MockExecutor {
    fn new() -> Self {
        MockExecutor {
            queries: Arc::new(Mutex::new(Vec::new())),
            insert_counter: Arc::new(Mutex::new(0)),
        }
    }
}

#[async_trait]
impl SqlExecutor for MockExecutor {
    async fn query(
        &self,
        sql: &str,
        params: Option<&[Value]>,
    ) -> Result<Vec<HashMap<String, Value>>, String> {
        self.queries.lock().unwrap().push(sql.to_string());
        let trimmed = sql.trim().to_lowercase();

        // Introspection: tables
        if trimmed.contains("information_schema.tables") && !trimmed.contains("table_constraints") {
            return Ok(vec![
                HashMap::from([("table_name".to_string(), Value::String("organization".to_string()))]),
                HashMap::from([("table_name".to_string(), Value::String("user".to_string()))]),
            ]);
        }

        // Introspection: columns
        if trimmed.contains("information_schema.columns") && !trimmed.contains("table_constraints") {
            return Ok(vec![
                HashMap::from([
                    ("table_name".to_string(), Value::String("organization".to_string())),
                    ("column_name".to_string(), Value::String("id".to_string())),
                    ("data_type".to_string(), Value::String("uuid".to_string())),
                    ("udt_name".to_string(), Value::String("uuid".to_string())),
                    ("is_nullable".to_string(), Value::String("NO".to_string())),
                    ("column_default".to_string(), Value::String("gen_random_uuid()".to_string())),
                ]),
                HashMap::from([
                    ("table_name".to_string(), Value::String("organization".to_string())),
                    ("column_name".to_string(), Value::String("name".to_string())),
                    ("data_type".to_string(), Value::String("text".to_string())),
                    ("udt_name".to_string(), Value::String("text".to_string())),
                    ("is_nullable".to_string(), Value::String("NO".to_string())),
                    ("column_default".to_string(), Value::Null),
                ]),
                HashMap::from([
                    ("table_name".to_string(), Value::String("user".to_string())),
                    ("column_name".to_string(), Value::String("id".to_string())),
                    ("data_type".to_string(), Value::String("uuid".to_string())),
                    ("udt_name".to_string(), Value::String("uuid".to_string())),
                    ("is_nullable".to_string(), Value::String("NO".to_string())),
                    ("column_default".to_string(), Value::String("gen_random_uuid()".to_string())),
                ]),
                HashMap::from([
                    ("table_name".to_string(), Value::String("user".to_string())),
                    ("column_name".to_string(), Value::String("email".to_string())),
                    ("data_type".to_string(), Value::String("text".to_string())),
                    ("udt_name".to_string(), Value::String("text".to_string())),
                    ("is_nullable".to_string(), Value::String("NO".to_string())),
                    ("column_default".to_string(), Value::Null),
                ]),
                HashMap::from([
                    ("table_name".to_string(), Value::String("user".to_string())),
                    ("column_name".to_string(), Value::String("name".to_string())),
                    ("data_type".to_string(), Value::String("text".to_string())),
                    ("udt_name".to_string(), Value::String("text".to_string())),
                    ("is_nullable".to_string(), Value::String("NO".to_string())),
                    ("column_default".to_string(), Value::Null),
                ]),
                HashMap::from([
                    ("table_name".to_string(), Value::String("user".to_string())),
                    ("column_name".to_string(), Value::String("organization_id".to_string())),
                    ("data_type".to_string(), Value::String("uuid".to_string())),
                    ("udt_name".to_string(), Value::String("uuid".to_string())),
                    ("is_nullable".to_string(), Value::String("NO".to_string())),
                    ("column_default".to_string(), Value::Null),
                ]),
            ]);
        }

        // Introspection: FKs
        if trimmed.contains("foreign key") {
            return Ok(vec![HashMap::from([
                ("from_table".to_string(), Value::String("user".to_string())),
                ("from_column".to_string(), Value::String("organization_id".to_string())),
                ("to_table".to_string(), Value::String("organization".to_string())),
                ("to_column".to_string(), Value::String("id".to_string())),
                ("is_nullable".to_string(), Value::String("NO".to_string())),
            ])]);
        }

        // Introspection: PKs
        if trimmed.contains("primary key") {
            return Ok(vec![
                HashMap::from([
                    ("table_name".to_string(), Value::String("organization".to_string())),
                    ("column_name".to_string(), Value::String("id".to_string())),
                ]),
                HashMap::from([
                    ("table_name".to_string(), Value::String("user".to_string())),
                    ("column_name".to_string(), Value::String("id".to_string())),
                ]),
            ]);
        }

        // Introspection: enum types
        if trimmed.contains("pg_type") {
            return Ok(vec![]);
        }

        // INSERT: return a fake record
        if trimmed.starts_with("insert") {
            let mut counter = self.insert_counter.lock().unwrap();
            let id = format!("mock-id-{}", *counter);
            *counter += 1;
            let mut record = HashMap::new();
            record.insert("id".to_string(), Value::String(id));

            // Parse column names and map params
            if let Some(params) = params {
                if let Some(col_start) = sql.find('(') {
                    if let Some(col_end) = sql[col_start..].find(')') {
                        let col_str = &sql[col_start + 1..col_start + col_end];
                        let cols: Vec<&str> = col_str
                            .split(',')
                            .map(|c| c.trim().trim_matches('"'))
                            .collect();
                        for (i, col) in cols.iter().enumerate() {
                            if i < params.len() {
                                record.insert(col.to_string(), params[i].clone());
                            }
                        }
                    }
                }
            }

            return Ok(vec![record]);
        }

        Ok(vec![])
    }

    async fn transaction(
        &self,
        f: Box<
            dyn for<'a> FnOnce(
                    &'a dyn SqlExecutor,
                ) -> std::pin::Pin<
                    Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>,
                > + Send,
        >,
    ) -> Result<(), String> {
        f(self).await
    }
}

fn make_config_with_factories(
    executor: MockExecutor,
    factories: Option<FactoryRegistry>,
) -> HandlerConfig {
    HandlerConfig {
        executor: Box::new(executor),
        scope_field: "organizationId".to_string(),
        shared_secret: "test-secret".to_string(),
        signing_secret: "test-signing-secret".to_string(),
        auth: Box::new(|_user, _ctx| {
            HashMap::from([("token".to_string(), Value::String("test-token".to_string()))])
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
        factories,
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

// ---------- Simple factory struct for tests ----------

struct SimpleFactory {
    create_fn: Box<
        dyn Fn(
                HashMap<String, Value>,
            ) -> Result<HashMap<String, Value>, AutonomaError>
            + Send
            + Sync,
    >,
    teardown_fn: Option<
        Box<dyn Fn(&HashMap<String, Value>) -> Result<(), AutonomaError> + Send + Sync>,
    >,
}

#[async_trait]
impl Factory for SimpleFactory {
    async fn create(
        &self,
        data: HashMap<String, Value>,
        _ctx: &FactoryContext<'_>,
    ) -> Result<HashMap<String, Value>, AutonomaError> {
        (self.create_fn)(data)
    }

    async fn teardown(
        &self,
        record: &HashMap<String, Value>,
        _ctx: &FactoryContext<'_>,
    ) -> Result<(), AutonomaError> {
        match &self.teardown_fn {
            Some(f) => f(record),
            None => Err(AutonomaError {
                message: "no factory teardown".to_string(),
                code: "NO_FACTORY_TEARDOWN".to_string(),
                status: 500,
            }),
        }
    }

    fn has_teardown(&self) -> bool {
        self.teardown_fn.is_some()
    }
}

/// Factory that captures received data and context info.
struct CapturingFactory {
    create_fn: Box<
        dyn Fn(
                HashMap<String, Value>,
            ) -> Result<HashMap<String, Value>, AutonomaError>
            + Send
            + Sync,
    >,
    received_data: Arc<Mutex<Vec<HashMap<String, Value>>>>,
    received_test_run_id: Arc<Mutex<Option<String>>>,
    received_refs: Arc<Mutex<Option<HashMap<String, Vec<HashMap<String, Value>>>>>>,
}

#[async_trait]
impl Factory for CapturingFactory {
    async fn create(
        &self,
        data: HashMap<String, Value>,
        ctx: &FactoryContext<'_>,
    ) -> Result<HashMap<String, Value>, AutonomaError> {
        self.received_data.lock().unwrap().push(data.clone());
        *self.received_test_run_id.lock().unwrap() = Some(ctx.test_run_id.clone());
        *self.received_refs.lock().unwrap() = Some(ctx.refs.clone());
        (self.create_fn)(data)
    }

    async fn teardown(
        &self,
        _record: &HashMap<String, Value>,
        _ctx: &FactoryContext<'_>,
    ) -> Result<(), AutonomaError> {
        Err(AutonomaError {
            message: "no factory teardown".to_string(),
            code: "NO_FACTORY_TEARDOWN".to_string(),
            status: 500,
        })
    }

    fn has_teardown(&self) -> bool {
        false
    }
}

// ---------- Tests ----------

#[tokio::test]
async fn factory_create_instead_of_sql() {
    let executor = MockExecutor::new();
    let queries = executor.queries.clone();

    let mut factories: FactoryRegistry = HashMap::new();
    factories.insert(
        "Organization".to_string(),
        Box::new(SimpleFactory {
            create_fn: Box::new(|data| {
                Ok(HashMap::from([
                    ("id".to_string(), Value::String("factory-org-1".to_string())),
                    ("name".to_string(), data.get("name").cloned().unwrap_or(Value::Null)),
                ]))
            }),
            teardown_fn: None,
        }),
    );

    let config = make_config_with_factories(executor, Some(factories));
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

    // No INSERT query for Organization should have been issued
    let all_queries = queries.lock().unwrap();
    let org_inserts: Vec<&String> = all_queries
        .iter()
        .filter(|q| {
            let lower = q.to_lowercase();
            lower.contains("insert") && lower.contains("organization")
        })
        .collect();
    assert!(org_inserts.is_empty(), "Factory should bypass SQL INSERT");
}

#[tokio::test]
async fn hybrid_mode_factory_and_sql() {
    let executor = MockExecutor::new();
    let queries = executor.queries.clone();

    let mut factories: FactoryRegistry = HashMap::new();
    factories.insert(
        "Organization".to_string(),
        Box::new(SimpleFactory {
            create_fn: Box::new(|data| {
                Ok(HashMap::from([
                    ("id".to_string(), Value::String("factory-org-1".to_string())),
                    ("name".to_string(), data.get("name").cloned().unwrap_or(Value::Null)),
                ]))
            }),
            teardown_fn: None,
        }),
    );
    // User has no factory - falls back to SQL

    let config = make_config_with_factories(executor, Some(factories));
    let body = json!({
        "action": "up",
        "create": {
            "Organization": [{ "name": "HybridOrg" }],
            "User": [{ "email": "test@example.com", "name": "Test" }]
        },
        "testRunId": "run-hybrid"
    });
    let req = signed_request(&body.to_string(), "test-secret");
    let resp = handle_request(&config, &req).await;

    assert_eq!(resp.status, 200);

    // User should have been created via SQL INSERT
    let all_queries = queries.lock().unwrap();
    let user_inserts: Vec<&String> = all_queries
        .iter()
        .filter(|q| {
            let lower = q.to_lowercase();
            lower.contains("insert") && lower.contains("\"user\"")
        })
        .collect();
    assert!(
        !user_inserts.is_empty(),
        "User model without factory should use SQL INSERT"
    );
}

#[tokio::test]
async fn factory_receives_resolved_fk_ids() {
    let received_data: Arc<Mutex<Vec<HashMap<String, Value>>>> =
        Arc::new(Mutex::new(Vec::new()));
    let received_data_clone = received_data.clone();

    let mut factories: FactoryRegistry = HashMap::new();
    factories.insert(
        "Organization".to_string(),
        Box::new(SimpleFactory {
            create_fn: Box::new(|data| {
                Ok(HashMap::from([
                    ("id".to_string(), Value::String("resolved-org-id".to_string())),
                    ("name".to_string(), data.get("name").cloned().unwrap_or(Value::Null)),
                ]))
            }),
            teardown_fn: None,
        }),
    );
    factories.insert(
        "User".to_string(),
        Box::new(CapturingFactory {
            create_fn: Box::new(move |data| {
                Ok(HashMap::from([
                    ("id".to_string(), Value::String("user-1".to_string())),
                    (
                        "email".to_string(),
                        data.get("email").cloned().unwrap_or(Value::Null),
                    ),
                    (
                        "organizationId".to_string(),
                        data.get("organizationId").cloned().unwrap_or(Value::Null),
                    ),
                ]))
            }),
            received_data: received_data_clone,
            received_test_run_id: Arc::new(Mutex::new(None)),
            received_refs: Arc::new(Mutex::new(None)),
        }),
    );

    let config = make_config_with_factories(MockExecutor::new(), Some(factories));
    // Nest User under Organization so tree resolver wires the FK
    let body = json!({
        "action": "up",
        "create": {
            "Organization": [{ "name": "Org", "User": [{ "email": "a@b.com", "name": "A" }] }]
        },
        "testRunId": "run-fk"
    });
    let req = signed_request(&body.to_string(), "test-secret");
    let resp = handle_request(&config, &req).await;

    assert_eq!(resp.status, 200);

    let data = received_data.lock().unwrap();
    assert!(!data.is_empty(), "User factory should have been called");
    // The User factory should receive the real org ID, not __temp_Organization_0
    let user_data = &data[0];
    assert_eq!(
        user_data.get("organizationId"),
        Some(&Value::String("resolved-org-id".to_string())),
        "Factory should receive resolved FK ID, not temp ID"
    );
}

#[tokio::test]
async fn factory_errors_when_pk_missing() {
    let mut factories: FactoryRegistry = HashMap::new();
    factories.insert(
        "Organization".to_string(),
        Box::new(SimpleFactory {
            create_fn: Box::new(|data| {
                // Return record without 'id' field
                Ok(HashMap::from([(
                    "name".to_string(),
                    data.get("name").cloned().unwrap_or(Value::Null),
                )]))
            }),
            teardown_fn: None,
        }),
    );

    let config = make_config_with_factories(MockExecutor::new(), Some(factories));
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
        Box::new(SimpleFactory {
            create_fn: Box::new(|data| {
                let name = data
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                Ok(HashMap::from([
                    ("id".to_string(), Value::String(format!("org-{}", name))),
                    ("name".to_string(), Value::String(name.to_string())),
                ]))
            }),
            teardown_fn: Some(Box::new(move |record| {
                if let Some(id) = record.get("id").and_then(|v| v.as_str()) {
                    teardown_calls_clone.lock().unwrap().push(id.to_string());
                }
                Ok(())
            })),
        }),
    );

    let config = make_config_with_factories(MockExecutor::new(), Some(factories));

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
async fn sql_teardown_when_factory_has_no_teardown() {
    let executor = MockExecutor::new();
    let queries = executor.queries.clone();

    let mut factories: FactoryRegistry = HashMap::new();
    factories.insert(
        "Organization".to_string(),
        Box::new(SimpleFactory {
            create_fn: Box::new(|data| {
                Ok(HashMap::from([
                    ("id".to_string(), Value::String("org-1".to_string())),
                    ("name".to_string(), data.get("name").cloned().unwrap_or(Value::Null)),
                ]))
            }),
            teardown_fn: None, // No teardown — SQL DELETE should be used
        }),
    );

    let config = make_config_with_factories(executor, Some(factories));

    let up_body = json!({
        "action": "up",
        "create": { "Organization": [{ "name": "Org" }] },
        "testRunId": "run-sql-td"
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

    assert_eq!(down_resp.status, 200);

    // SQL DELETE should have been used
    let all_queries = queries.lock().unwrap();
    let delete_queries: Vec<&String> = all_queries
        .iter()
        .filter(|q| q.to_lowercase().contains("delete"))
        .collect();
    assert!(
        !delete_queries.is_empty(),
        "SQL DELETE should be used when factory has no teardown"
    );
}

#[tokio::test]
async fn factory_context_contains_refs() {
    let received_refs: Arc<Mutex<Option<HashMap<String, Vec<HashMap<String, Value>>>>>> =
        Arc::new(Mutex::new(None));
    let received_test_run_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let refs_clone = received_refs.clone();
    let trid_clone = received_test_run_id.clone();

    let mut factories: FactoryRegistry = HashMap::new();
    factories.insert(
        "Organization".to_string(),
        Box::new(SimpleFactory {
            create_fn: Box::new(|data| {
                Ok(HashMap::from([
                    ("id".to_string(), Value::String("org-ctx".to_string())),
                    ("name".to_string(), data.get("name").cloned().unwrap_or(Value::Null)),
                ]))
            }),
            teardown_fn: None,
        }),
    );
    factories.insert(
        "User".to_string(),
        Box::new(CapturingFactory {
            create_fn: Box::new(|data| {
                Ok(HashMap::from([
                    ("id".to_string(), Value::String("user-ctx".to_string())),
                    (
                        "email".to_string(),
                        data.get("email").cloned().unwrap_or(Value::Null),
                    ),
                    (
                        "organizationId".to_string(),
                        data.get("organizationId")
                            .cloned()
                            .unwrap_or(Value::Null),
                    ),
                ]))
            }),
            received_data: Arc::new(Mutex::new(Vec::new())),
            received_test_run_id: trid_clone,
            received_refs: refs_clone,
        }),
    );

    let config = make_config_with_factories(MockExecutor::new(), Some(factories));
    let body = json!({
        "action": "up",
        "create": {
            "Organization": [{ "name": "Org" }],
            "User": [{ "email": "x@y.com", "name": "X" }]
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
