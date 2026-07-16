//! Request routing for discover/up/down protocol actions.
//!
//! Factory-driven design: every model in `body.create` must have a
//! registered factory. The SDK uses the factory's `input_fields` both
//! to validate inputs and to build the `discover` schema. Ordering for
//! `up` and `down` comes from the create payload's `_alias`/`_ref` graph;
//! there is no SQL introspection.

use regex::{Captures, Regex};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::OnceLock;
use uuid::Uuid;

use crate::errors::*;
use crate::factory::validate_input;
use crate::hmac::verify_signature;
use crate::payload_topo::{compute_teardown_order, resolve_payload_tree};
use crate::refs::{sign_refs, verify_refs};
use crate::schema::{build_schema_from_factories, schema_to_wire};
use crate::types::{
    AuthContext, FactoryContext, HandlerConfig, HandlerRequest, HandlerResponse, HookContext,
};

pub const PROTOCOL_VERSION: &str = include_str!("../../../protocol/version.txt").trim_ascii();

fn build_sdk_meta(config: &HandlerConfig) -> Value {
    let sdk = config.sdk.as_ref();
    json!({
        "version": PROTOCOL_VERSION,
        "sdk": {
            "language": "rust",
            "orm": sdk.map(|s| s.orm.as_str()).unwrap_or("unknown"),
            "server": sdk.map(|s| s.server.as_str()).unwrap_or("unknown"),
        }
    })
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

    let body: Value =
        serde_json::from_str(&req.body).map_err(|_| invalid_body("invalid JSON"))?;

    let action = body
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or_else(|| invalid_body("missing action. expected one of 'discover', 'up' or 'down'"))?;

    match action {
        "discover" => handle_discover(config).await,
        "up" => handle_up(config, &body).await,
        "down" => handle_down(config, &body).await,
        _ => Err(unknown_action(action)),
    }
}

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

async fn handle_discover(config: &HandlerConfig) -> Result<HandlerResponse, AutonomaError> {
    let schema = build_schema_from_factories(&config.factories, &config.scope_field);
    let wire = schema_to_wire(&schema);

    let mut response = build_sdk_meta(config)
        .as_object()
        .cloned()
        .unwrap_or_default();
    response.insert("schema".to_string(), wire);

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
    let create = body
        .get("create")
        .and_then(|v| v.as_object())
        .ok_or_else(|| invalid_body("missing \"create\" in request body"))?;

    let test_run_id = body
        .get("testRunId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    if config.factories.is_empty() {
        return Err(invalid_body(
            "no factories registered — every model in `create` must have a factory.",
        ));
    }

    let tree = resolve_payload_tree(create)?;

    let mut refs: HashMap<String, Vec<serde_json::Map<String, Value>>> = HashMap::new();
    let mut id_map: HashMap<String, Value> = HashMap::new();

    // Track per-model run index for {{index}} / {{cycle()}} substitution.
    let mut model_index: HashMap<String, usize> = HashMap::new();

    for op in &tree.ops {
        let model = &op.model;
        let factory = config.factories.get(model).ok_or_else(|| {
            invalid_body(&format!(
                "no factory registered for model \"{}\". Register one with `define_factory(...)` and add it to HandlerConfig.factories.",
                model
            ))
        })?;

        let idx = model_index.entry(model.clone()).or_insert(0);
        let current_idx = *idx;
        *model_index.get_mut(model).unwrap() += 1;

        // Substitute built-in tokens then swap temp ids for real ids.
        let resolved_val = resolve_tokens(&Value::Object(op.fields.clone()), &test_run_id, current_idx)?;
        let resolved_map = match resolved_val {
            Value::Object(m) => m,
            _ => op.fields.clone(),
        };
        let swapped_val = swap_temp_ids(&Value::Object(resolved_map), &id_map);
        let resolved = match swapped_val {
            Value::Object(m) => m,
            _ => serde_json::Map::new(),
        };

        // Validate through the factory's input_fields.
        validate_input(&resolved, &factory.input_fields).map_err(|e| {
            invalid_body(&format!("validation error for \"{}\": {}", model, e))
        })?;

        // Call factory create.
        let ctx = FactoryContext {
            refs: refs
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            scenario_name: test_run_id.clone(),
            test_run_id: test_run_id.clone(),
        };

        let record = (factory.create_fn)(&resolved, &ctx).await?;

        if record.get("id").map_or(true, |v| v.is_null()) {
            return Err(AutonomaError {
                message: format!("Factory for \"{}\" must return a record dict with \"id\"", model),
                code: "FACTORY_MISSING_PK".to_string(),
                status: 500,
            });
        }

        refs.entry(model.clone()).or_default().push(record.clone());
        if let Some(record_id) = record.get("id") {
            id_map.insert(op.temp_id.clone(), record_id.clone());
        }
    }

    // Auth callback gets the first User (case-insensitive on model name).
    let first_user = find_first_user(&refs);
    let scope_value = detect_scope_value(&refs, &config.scope_field)
        .unwrap_or_else(|| test_run_id.clone());
    let auth_context = AuthContext {
        scope_value: &scope_value,
        refs: &refs,
    };
    let mut auth = (config.auth)(first_user.as_ref(), &auth_context).await;

    if let Some(ref after_up) = config.after_up {
        let hook_ctx = HookContext {
            scenario_name: scope_value.clone(),
            refs: refs.clone(),
        };
        auth = after_up(&hook_ctx, auth).await;
    }

    // Convert refs to Value for the wire response.
    let refs_value = refs_to_value(&refs);

    // Build alias_dependencies and alias_owner_model for the refsToken as Value maps.
    let alias_deps_value: Value = json!(tree.alias_dependencies);
    let alias_owner_value: Value = json!(tree.alias_owner_model);

    let refs_token = sign_refs(
        &json!({
            "refs": refs_value,
            "testRunId": scope_value,
            "environment": "",
            "aliasDependencies": alias_deps_value,
            "aliasOwnerModel": alias_owner_value,
        }),
        &config.signing_secret,
    );

    let mut response = build_sdk_meta(config)
        .as_object()
        .cloned()
        .unwrap_or_default();
    let auth_value: Value = json!(auth);
    response.insert("auth".to_string(), auth_value);
    response.insert("refs".to_string(), refs_value);
    response.insert("refsToken".to_string(), Value::String(refs_token));

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
    let refs_token = body
        .get("refsToken")
        .and_then(|v| v.as_str())
        .ok_or_else(|| invalid_body("missing refsToken"))?;

    let payload = verify_refs(refs_token, &config.signing_secret)
        .map_err(|e| invalid_refs_token(&e))?;

    let refs: HashMap<String, Vec<serde_json::Map<String, Value>>> =
        if let Some(refs_val) = payload.get("refs") {
            parse_refs_value(refs_val)
        } else {
            HashMap::new()
        };

    let test_run_id = payload
        .get("testRunId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Parse alias dependency info from the token.
    let alias_deps: Option<HashMap<String, Vec<String>>> =
        payload.get("aliasDependencies").and_then(|v| {
            v.as_object().map(|obj| {
                obj.iter()
                    .map(|(k, v)| {
                        let deps = v
                            .as_array()
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|s| s.as_str().map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default();
                        (k.clone(), deps)
                    })
                    .collect()
            })
        });

    let alias_owner_model: Option<HashMap<String, String>> =
        payload.get("aliasOwnerModel").and_then(|v| {
            v.as_object().map(|obj| {
                obj.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
        });

    if let Some(ref before_down) = config.before_down {
        let hook_ctx = HookContext {
            scenario_name: test_run_id.clone(),
            refs: refs.clone(),
        };
        before_down(&hook_ctx).await;
    }

    let teardown_order = compute_teardown_order(
        &refs,
        alias_deps.as_ref(),
        alias_owner_model.as_ref(),
    );

    for model in &teardown_order {
        let factory = match config.factories.get(model) {
            Some(f) => f,
            None => continue, // No factory means no teardown for this model.
        };

        let teardown_fn = match &factory.teardown_fn {
            Some(f) => f,
            None => continue, // No teardown function registered; skip.
        };

        let records = refs.get(model).cloned().unwrap_or_default();
        let ctx = FactoryContext {
            refs: refs.clone(),
            scenario_name: test_run_id.clone(),
            test_run_id: test_run_id.clone(),
        };

        // Teardown records in reverse order.
        for record in records.iter().rev() {
            teardown_fn(record, &ctx).await.map_err(|e| AutonomaError {
                message: e.message,
                code: "FACTORY_TEARDOWN_ERROR".to_string(),
                status: 500,
            })?;
        }
    }

    let mut response = build_sdk_meta(config)
        .as_object()
        .cloned()
        .unwrap_or_default();
    response.insert("ok".to_string(), Value::Bool(true));

    Ok(HandlerResponse {
        status: 200,
        body: Value::Object(response),
    })
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

fn token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{\{\s*([^{}]+?)\s*\}\}").unwrap())
}

fn cycle_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^cycle\((.*)\)$").unwrap())
}

fn resolve_tokens_str(
    input: &str,
    test_run_id: &str,
    index: usize,
) -> Result<String, AutonomaError> {
    let mut err: Option<AutonomaError> = None;
    let result = token_re().replace_all(input, |caps: &Captures| {
        if err.is_some() {
            return String::new();
        }
        let token = caps[1].trim();
        if token == "testRunId" {
            return test_run_id.to_string();
        }
        if token == "index" {
            return index.to_string();
        }
        if let Some(cycle_caps) = cycle_re().captures(token) {
            let inner = &cycle_caps[1];
            let parts: Vec<String> = inner
                .split(',')
                .map(|p| {
                    let t = p.trim();
                    let bytes = t.as_bytes();
                    if bytes.len() >= 2
                        && ((bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'')
                            || (bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"'))
                    {
                        t[1..t.len() - 1].to_string()
                    } else {
                        t.to_string()
                    }
                })
                .collect();
            if parts.is_empty() {
                return String::new();
            }
            return parts[index % parts.len()].clone();
        }
        err = Some(AutonomaError {
            message: format!("Unresolved token: {{{{{}}}}}", token),
            code: "UNRESOLVED_TOKEN".to_string(),
            status: 400,
        });
        String::new()
    });
    if let Some(e) = err {
        return Err(e);
    }
    Ok(result.into_owned())
}

/// Substitute built-in tokens in field values: {{testRunId}}, {{index}},
/// {{cycle(a,b,c)}}. Returns UNRESOLVED_TOKEN error for any other {{token}}.
pub fn resolve_tokens(
    value: &Value,
    test_run_id: &str,
    index: usize,
) -> Result<Value, AutonomaError> {
    match value {
        Value::String(s) => Ok(Value::String(resolve_tokens_str(s, test_run_id, index)?)),
        Value::Array(arr) => {
            let mut out = Vec::with_capacity(arr.len());
            for v in arr {
                out.push(resolve_tokens(v, test_run_id, index)?);
            }
            Ok(Value::Array(out))
        }
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                out.insert(k.clone(), resolve_tokens(v, test_run_id, index)?);
            }
            Ok(Value::Object(out))
        }
        _ => Ok(value.clone()),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Replace any `__temp_*` placeholder string with its real id.
fn swap_temp_ids(value: &Value, id_map: &HashMap<String, Value>) -> Value {
    match value {
        Value::String(s) if s.starts_with("__temp_") => {
            id_map.get(s).cloned().unwrap_or_else(|| value.clone())
        }
        Value::Object(map) => {
            let resolved: serde_json::Map<String, Value> = map
                .iter()
                .map(|(k, v)| (k.clone(), swap_temp_ids(v, id_map)))
                .collect();
            Value::Object(resolved)
        }
        Value::Array(arr) => {
            Value::Array(arr.iter().map(|v| swap_temp_ids(v, id_map)).collect())
        }
        _ => value.clone(),
    }
}

fn find_first_user(
    refs: &HashMap<String, Vec<serde_json::Map<String, Value>>>,
) -> Option<serde_json::Map<String, Value>> {
    for (model, records) in refs {
        let normalized = model.to_lowercase();
        if (normalized == "user" || normalized == "users") && !records.is_empty() {
            return Some(records[0].clone());
        }
    }
    None
}

fn normalize_field(name: &str) -> String {
    name.replace('_', "").to_lowercase()
}

fn detect_scope_value(
    refs: &HashMap<String, Vec<serde_json::Map<String, Value>>>,
    scope_field: &str,
) -> Option<String> {
    let scope_normalized = normalize_field(scope_field);
    for records in refs.values() {
        for record in records {
            for (key, value) in record {
                if normalize_field(key) == scope_normalized {
                    if let Some(s) = value.as_str() {
                        return Some(s.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Convert the internal refs HashMap to a serde_json::Value for the wire response.
fn refs_to_value(refs: &HashMap<String, Vec<serde_json::Map<String, Value>>>) -> Value {
    let map: serde_json::Map<String, Value> = refs
        .iter()
        .map(|(k, v)| {
            let arr: Vec<Value> = v.iter().map(|r| Value::Object(r.clone())).collect();
            (k.clone(), Value::Array(arr))
        })
        .collect();
    Value::Object(map)
}

/// Parse a refs Value (from a refsToken payload) back into the internal HashMap form.
fn parse_refs_value(
    refs_val: &Value,
) -> HashMap<String, Vec<serde_json::Map<String, Value>>> {
    let mut result: HashMap<String, Vec<serde_json::Map<String, Value>>> = HashMap::new();
    if let Some(obj) = refs_val.as_object() {
        for (model, arr_val) in obj {
            if let Some(arr) = arr_val.as_array() {
                let records: Vec<serde_json::Map<String, Value>> = arr
                    .iter()
                    .filter_map(|v| v.as_object().cloned())
                    .collect();
                result.insert(model.clone(), records);
            }
        }
    }
    result
}
