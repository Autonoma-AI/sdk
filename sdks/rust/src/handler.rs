//! Request routing for discover/up/down protocol actions.

use chrono::{DateTime, Utc};
use regex::{Captures, Regex};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::OnceLock;
use uuid::Uuid;

use std::collections::HashSet;

use crate::create::{create_entities, update_entity};
use crate::dialect::get_dialect;
use crate::errors::*;
use crate::hmac::verify_signature;
use crate::introspect::introspect_database;
use crate::refs::{sign_refs, verify_refs};
use crate::teardown::{compute_teardown_order, teardown};
use crate::tree::resolve_tree;
use crate::types::{AuthContext, FactoryContext, HandlerConfig, HandlerRequest, HandlerResponse, HookContext, IntrospectionResult};

pub const PROTOCOL_VERSION: &str = include_str!("../../../protocol/version.txt").trim_ascii();

async fn get_introspection(config: &HandlerConfig) -> Result<IntrospectionResult, String> {
    config
        .introspection_cache
        .get_or_try_init(|| async {
            let dialect = get_dialect(&config.dialect);
            introspect_database(
                config.executor.as_ref(),
                dialect.as_ref(),
                &config.scope_field,
                config.db_schema.as_deref(),
                config.table_name_map.as_ref(),
                config.exclude_tables.as_deref(),
            )
            .await
        })
        .await
        .cloned()
}

fn is_autonoma_enabled() -> bool {
    parse_autonoma_enabled(std::env::var("AUTONOMA_ENABLED").ok().as_deref())
}

pub(crate) fn parse_autonoma_enabled(raw: Option<&str>) -> bool {
    match raw {
        Some(s) => {
            let v = s.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes"
        }
        None => false,
    }
}

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

    if !config.allow_production && !is_autonoma_enabled() {
        if std::env::var("RUST_ENV").as_deref() == Ok("production")
            || std::env::var("ENV").as_deref() == Ok("production")
        {
            return Err(production_blocked());
        }
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

    let body: Value = serde_json::from_str(&req.body)
        .map_err(|_| invalid_body("invalid JSON"))?;

    let action = body
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or_else(|| invalid_body("missing action"))?;

    match action {
        "discover" => handle_discover(config).await,
        "up" => handle_up(config, &body).await,
        "down" => handle_down(config, &body).await,
        _ => Err(unknown_action(action)),
    }
}

async fn handle_discover(config: &HandlerConfig) -> Result<HandlerResponse, AutonomaError> {
    let introspection = get_introspection(config)
        .await
        .map_err(|e| AutonomaError {
            message: e,
            code: "INTROSPECTION_ERROR".to_string(),
            status: 500,
        })?;

    let schema = &introspection.schema;
    let schema_dict = json!({
        "models": schema.models.iter().map(|m| {
            json!({
                "name": m.name,
                "tableName": m.table_name,
                "fields": m.fields.iter().map(|f| {
                    json!({
                        "name": f.name,
                        "type": f.field_type,
                        "isRequired": f.is_required,
                        "isId": f.is_id,
                        "hasDefault": f.has_default
                    })
                }).collect::<Vec<_>>()
            })
        }).collect::<Vec<_>>(),
        "edges": schema.edges.iter().map(|e| {
            json!({
                "from": e.from_model,
                "to": e.to_model,
                "localField": e.local_field,
                "foreignField": e.foreign_field,
                "nullable": e.nullable
            })
        }).collect::<Vec<_>>(),
        "relations": schema.relations.iter().map(|r| {
            json!({
                "parentModel": r.parent_model,
                "childModel": r.child_model,
                "parentField": r.parent_field,
                "childField": r.child_field
            })
        }).collect::<Vec<_>>(),
        "scopeField": schema.scope_field
    });

    let mut response = build_sdk_meta(config)
        .as_object()
        .cloned()
        .unwrap_or_default();
    response.insert("schema".to_string(), schema_dict);

    Ok(HandlerResponse {
        status: 200,
        body: Value::Object(response),
    })
}

async fn handle_up(config: &HandlerConfig, body: &Value) -> Result<HandlerResponse, AutonomaError> {
    let create = body
        .get("create")
        .ok_or_else(|| invalid_body("missing \"create\" in request body"))?;

    let test_run_id = body
        .get("testRunId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let introspection = get_introspection(config)
        .await
        .map_err(|e| AutonomaError {
            message: e,
            code: "INTROSPECTION_ERROR".to_string(),
            status: 500,
        })?;

    let schema = &introspection.schema;
    let dialect = get_dialect(&config.dialect);

    let tree = resolve_tree(create, schema);
    let mut refs: HashMap<String, Vec<HashMap<String, Value>>> = HashMap::new();
    // Bug 3: id_map accepts both String and numeric values (not just String)
    let mut id_map: HashMap<String, Value> = HashMap::new();

    // Process operations
    let mut i = 0;
    while i < tree.ops.len() {
        let op = &tree.ops[i];
        let model = &op.model;

        // Collect consecutive ops for the same model with same batch flag
        let mut batch_end = i;
        while batch_end + 1 < tree.ops.len()
            && tree.ops[batch_end + 1].model == *model
            && tree.ops[batch_end + 1].batch == op.batch
        {
            batch_end += 1;
        }

        let batch_ops: Vec<&crate::types::CreateOp> = tree.ops[i..=batch_end].iter().collect();

        // Bug 4: Find model info for PK field name
        // When multiple is_id fields exist (composite PK), prefer the one named "id"
        let model_info = schema.models.iter().find(|m| m.name == *model);
        let id_fields: Vec<&crate::types::FieldInfo> = model_info
            .map(|mi| mi.fields.iter().filter(|f| f.is_id).collect())
            .unwrap_or_default();
        let pk_field = id_fields.iter().find(|f| f.name.eq_ignore_ascii_case("id"))
            .or(id_fields.first())
            .copied();
        let pk_field_name = pk_field.map(|f| f.name.as_str()).unwrap_or("id");

        let mut resolved_fields: Vec<HashMap<String, Value>> = Vec::new();
        for (batch_index, b) in batch_ops.iter().enumerate() {
            // Substitute built-in tokens ({{testRunId}}, {{index}}, {{cycle(...)}})
            let mut fields: HashMap<String, Value> = HashMap::new();
            for (k, v) in &b.fields {
                fields.insert(k.clone(), resolve_tokens(v, &test_run_id, batch_index)?);
            }

            // Replace temp IDs with real IDs (Bug 3: use Value, not just String)
            for (key, value) in fields.clone() {
                if let Some(s) = value.as_str() {
                    if s.starts_with("__temp_") {
                        if let Some(real_id) = id_map.get(s) {
                            fields.insert(key, real_id.clone());
                        }
                    }
                }
            }

            // Inject scope field if applicable
            let scope_edge = schema.edges.iter().find(|e| {
                e.from_model == *model
                    && normalize_field(&e.local_field) == normalize_field(&schema.scope_field)
                    && e.from_model != e.to_model
            });
            if let Some(se) = scope_edge {
                if !fields.contains_key(&se.local_field) {
                    if let Some(scope_val) = detect_scope_value(&refs, &schema.scope_field) {
                        fields.insert(se.local_field.clone(), Value::String(scope_val));
                    }
                }
            }

            // Auto-populate required DateTime fields without defaults
            if let Some(mi) = model_info {
                for field in &mi.fields {
                    if field.is_required
                        && !field.has_default
                        && !field.is_id
                        && !fields.contains_key(&field.name)
                    {
                        if field.field_type == "DateTime" {
                            let now: DateTime<Utc> = Utc::now();
                            fields.insert(
                                field.name.clone(),
                                Value::String(now.to_rfc3339()),
                            );
                        }
                    }
                }
            }

            resolved_fields.push(fields);
        }

        // Check if a factory is registered for this model
        let has_factory = config
            .factories
            .as_ref()
            .map(|f| f.contains_key(model))
            .unwrap_or(false);

        let records: Vec<HashMap<String, Value>> = if has_factory {
            // Factory path: call user-defined create() for each record
            let factory = config.factories.as_ref().unwrap().get(model).unwrap();
            let mut factory_records = Vec::new();
            for fields in &resolved_fields {
                let factory_ctx = FactoryContext {
                    refs: &refs,
                    executor: config.executor.as_ref(),
                    scenario_name: test_run_id.clone(),
                    test_run_id: test_run_id.clone(),
                };
                let record = factory.create(fields.clone(), &factory_ctx).await?;
                if record.get(pk_field_name).map_or(true, |v| v.is_null()) {
                    return Err(AutonomaError {
                        message: format!(
                            "Factory for \"{}\" must return a record with \"{}\"",
                            model, pk_field_name
                        ),
                        code: "FACTORY_MISSING_PK".to_string(),
                        status: 500,
                    });
                }
                factory_records.push(record);
            }
            factory_records
        } else {
            // SQL fallback path (existing behavior)
            let fields_json: Vec<Value> = resolved_fields
                .iter()
                .map(|f| {
                    Value::Object(f.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                })
                .collect();

            let spec: HashMap<String, Value> = [(
                model.clone(),
                json!({
                    "count": resolved_fields.len(),
                    "fields": fields_json,
                    "batch": op.batch
                }),
            )]
            .into();

            let created = create_entities(
                config.executor.as_ref(),
                dialect.as_ref(),
                &introspection.table_map,
                &introspection.column_maps,
                &spec,
                &introspection.enum_type_maps,
                &schema.models,
            )
            .await
            .map_err(|e| AutonomaError {
                message: e,
                code: "CREATE_ERROR".to_string(),
                status: 500,
            })?;

            created.get(model).cloned().unwrap_or_default()
        };

        refs.entry(model.clone()).or_default().extend(records.clone());

        // Bug 3 + Bug 4: Use dynamic PK field, accept any non-null value
        for (j, b) in batch_ops.iter().enumerate() {
            if j < records.len() {
                if let Some(record_id) = records[j].get(pk_field_name) {
                    if !record_id.is_null() {
                        id_map.insert(b.temp_id.clone(), record_id.clone());
                    }
                }
            }
        }

        i = batch_end + 1;
    }

    // Resolve deferred FK updates
    for deferred in &tree.deferred_updates {
        let real_target_id = id_map.get(&deferred.target_temp_id);
        let ref_temp_id = tree.aliases.get(&deferred.ref_alias);
        let real_ref_id = ref_temp_id.and_then(|tid| id_map.get(tid));

        match (real_target_id, real_ref_id) {
            (Some(target_id), Some(ref_id)) => {
                let fields: HashMap<String, Value> =
                    [(deferred.field.clone(), ref_id.clone())].into();
                // Bug 4: find dynamic PK for deferred model
                // When multiple is_id fields exist (composite PK), prefer the one named "id"
                let deferred_model_info = schema.models.iter().find(|m| m.name == deferred.model);
                let deferred_id_fields: Vec<&crate::types::FieldInfo> = deferred_model_info
                    .map(|mi| mi.fields.iter().filter(|f| f.is_id).collect())
                    .unwrap_or_default();
                let deferred_pk_field_name = deferred_id_fields.iter()
                    .find(|f| f.name.eq_ignore_ascii_case("id"))
                    .or(deferred_id_fields.first())
                    .map(|f| f.name.as_str())
                    .unwrap_or("id");
                let target_id_str = match target_id {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    _ => target_id.to_string(),
                };
                update_entity(
                    config.executor.as_ref(),
                    dialect.as_ref(),
                    &introspection.table_map,
                    &introspection.column_maps,
                    &deferred.model,
                    &target_id_str,
                    &fields,
                    &introspection.enum_type_maps,
                    deferred_pk_field_name,
                )
                .await
                .map_err(|e| AutonomaError {
                    message: e,
                    code: "DEFERRED_UPDATE_ERROR".to_string(),
                    status: 500,
                })?;
            }
            _ => {
                return Err(AutonomaError {
                    message: format!(
                        "_ref \"{}\" could not be resolved. Ensure the referenced node has _alias defined in the scenario.",
                        deferred.ref_alias
                    ),
                    code: "REF_RESOLUTION_ERROR".to_string(),
                    status: 500,
                });
            }
        }
    }

    let scope_value = detect_scope_value(&refs, &schema.scope_field)
        .unwrap_or_else(|| test_run_id.clone());

    let first_user = find_first_user(&refs);
    let auth_context = AuthContext { scope_value: &scope_value, refs: &refs };
    let mut auth = (config.auth)(first_user.as_ref(), &auth_context);

    if let Some(ref after_up) = config.after_up {
        let hook_ctx = HookContext {
            scenario_name: scope_value.clone(),
            refs: refs.clone(),
        };
        auth = after_up(&hook_ctx, auth);
    }

    // Convert refs to Value
    let refs_map: serde_json::Map<String, Value> = refs
        .iter()
        .map(|(k, v)| {
            let arr: Vec<Value> = v
                .iter()
                .map(|r| Value::Object(r.iter().map(|(k, v)| (k.clone(), v.clone())).collect()))
                .collect();
            (k.clone(), Value::Array(arr))
        })
        .collect();
    let refs_value = Value::Object(refs_map);

    let refs_token = sign_refs(
        &json!({
            "refs": refs_value,
            "testRunId": scope_value,
            "environment": ""
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

async fn handle_down(config: &HandlerConfig, body: &Value) -> Result<HandlerResponse, AutonomaError> {
    let refs_token = body
        .get("refsToken")
        .and_then(|v| v.as_str())
        .ok_or_else(|| invalid_body("missing refsToken"))?;

    let payload = verify_refs(refs_token, &config.signing_secret)
        .map_err(|e| invalid_refs_token(&e))?;

    let introspection = get_introspection(config)
        .await
        .map_err(|e| AutonomaError {
            message: e,
            code: "INTROSPECTION_ERROR".to_string(),
            status: 500,
        })?;

    let dialect = get_dialect(&config.dialect);

    let test_run_id = payload
        .get("testRunId")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if let Some(ref before_down) = config.before_down {
        let refs_for_hook: HashMap<String, Vec<HashMap<String, Value>>> =
            if let Some(refs_val) = payload.get("refs") {
                serde_json::from_value(refs_val.clone()).unwrap_or_default()
            } else {
                HashMap::new()
            };
        let hook_ctx = HookContext {
            scenario_name: test_run_id.to_string(),
            refs: refs_for_hook,
        };
        before_down(&hook_ctx);
    }

    // Determine which models have factory teardown
    let mut factory_teardown_models: HashSet<String> = HashSet::new();
    if let Some(ref factories) = config.factories {
        for (model, factory) in factories {
            if factory.has_teardown() {
                factory_teardown_models.insert(model.clone());
            }
        }
    }

    // Run factory teardowns in reverse topo order
    if !factory_teardown_models.is_empty() {
        let teardown_info = compute_teardown_order(&introspection.schema);
        // Include scope root in the order for factory teardown
        let mut full_order = teardown_info.order.clone();
        if let Some(ref root) = teardown_info.scope_root_model {
            full_order.push(root.clone());
        }

        let refs_for_factory: HashMap<String, Vec<HashMap<String, Value>>> =
            if let Some(refs_val) = payload.get("refs") {
                serde_json::from_value(refs_val.clone()).unwrap_or_default()
            } else {
                HashMap::new()
            };

        // Process in reverse order
        for model in full_order.iter().rev() {
            if !factory_teardown_models.contains(model) {
                continue;
            }
            let records = refs_for_factory.get(model).cloned().unwrap_or_default();
            let factory = config.factories.as_ref().unwrap().get(model).unwrap();
            let factory_ctx = FactoryContext {
                refs: &refs_for_factory,
                executor: config.executor.as_ref(),
                scenario_name: test_run_id.to_string(),
                test_run_id: test_run_id.to_string(),
            };
            // Teardown records in reverse order
            for record in records.iter().rev() {
                factory.teardown(record, &factory_ctx).await.map_err(|e| AutonomaError {
                    message: e.message,
                    code: "FACTORY_TEARDOWN_ERROR".to_string(),
                    status: 500,
                })?;
            }
        }
    }

    let skip_models = if factory_teardown_models.is_empty() {
        None
    } else {
        Some(&factory_teardown_models)
    };

    teardown(
        config.executor.as_ref(),
        dialect.as_ref(),
        &introspection.table_map,
        &introspection.column_maps,
        &introspection.schema,
        test_run_id,
        payload.get("refs"),
        skip_models,
    )
    .await
    .map_err(|e| AutonomaError {
        message: e,
        code: "TEARDOWN_ERROR".to_string(),
        status: 500,
    })?;

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

fn token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{\{\s*([^{}]+?)\s*\}\}").unwrap())
}

fn cycle_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^cycle\((.*)\)$").unwrap())
}

fn resolve_tokens_str(input: &str, test_run_id: &str, index: usize) -> Result<String, AutonomaError> {
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
pub fn resolve_tokens(value: &Value, test_run_id: &str, index: usize) -> Result<Value, AutonomaError> {
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

fn find_first_user(refs: &HashMap<String, Vec<HashMap<String, Value>>>) -> Option<HashMap<String, Value>> {
    for (model, records) in refs {
        // Bug 8: Match both "user" and "users" (case-insensitive)
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
    refs: &HashMap<String, Vec<HashMap<String, Value>>>,
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

#[cfg(test)]
mod tests {
    use super::parse_autonoma_enabled;

    #[test]
    fn parse_autonoma_enabled_truthy() {
        for v in ["1", "true", "TRUE", "yes", "  yes  "] {
            assert!(parse_autonoma_enabled(Some(v)), "expected truthy for {v:?}");
        }
    }

    #[test]
    fn parse_autonoma_enabled_falsy() {
        assert!(!parse_autonoma_enabled(None));
        for v in ["", "0", "false", "no", "something"] {
            assert!(!parse_autonoma_enabled(Some(v)), "expected falsy for {v:?}");
        }
    }
}
