//! Request routing for discover/up/down protocol actions.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

use crate::create::{create_entities, update_entity};
use crate::dialect::get_dialect;
use crate::errors::*;
use crate::hmac::verify_signature;
use crate::introspect::introspect_database;
use crate::refs::{sign_refs, verify_refs};
use crate::teardown::teardown;
use crate::tree::resolve_tree;
use crate::types::{HandlerConfig, HandlerRequest, HandlerResponse, IntrospectionResult};

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

    if !config.allow_production {
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
        let model_info = schema.models.iter().find(|m| m.name == *model);
        let pk_field = model_info.and_then(|mi| mi.fields.iter().find(|f| f.is_id));
        let pk_field_name = pk_field.map(|f| f.name.as_str()).unwrap_or("id");

        let mut resolved_fields: Vec<HashMap<String, Value>> = Vec::new();
        for b in &batch_ops {
            let mut fields: HashMap<String, Value> = b
                .fields
                .iter()
                .filter(|(k, _)| k.as_str() != pk_field_name)
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();

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
                    && e.local_field.to_lowercase() == schema.scope_field.to_lowercase()
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

        let records = created.get(model).cloned().unwrap_or_default();

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
                let deferred_model_info = schema.models.iter().find(|m| m.name == deferred.model);
                let deferred_pk_field_name = deferred_model_info
                    .and_then(|mi| mi.fields.iter().find(|f| f.is_id))
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
    let auth = (config.auth)(first_user.as_ref());

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

    teardown(
        config.executor.as_ref(),
        dialect.as_ref(),
        &introspection.table_map,
        &introspection.column_maps,
        &introspection.schema,
        test_run_id,
        payload.get("refs"),
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

fn detect_scope_value(
    refs: &HashMap<String, Vec<HashMap<String, Value>>>,
    scope_field: &str,
) -> Option<String> {
    let scope_lower = scope_field.to_lowercase();
    for records in refs.values() {
        for record in records {
            for (key, value) in record {
                if key.to_lowercase() == scope_lower {
                    if let Some(s) = value.as_str() {
                        return Some(s.to_string());
                    }
                }
            }
        }
    }
    None
}
