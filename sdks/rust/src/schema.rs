//! Build the SDK's wire-shape schema from registered factories.
//!
//! The dashboard's `discover` response carries a `schema` block that lists
//! every model the host can create, along with each model's fields. With
//! this design it comes from each factory's `input_fields` (a `Vec<FieldDef>`).

use serde_json::{json, Value};

use crate::types::{FactoryRegistry, FieldInfo, ModelInfo, SchemaInfo};

/// Convert `OrgMember` to `org_member` for cosmetic `tableName`.
fn camel_to_snake(name: &str) -> String {
    let mut out = String::new();
    for (i, ch) in name.chars().enumerate() {
        if ch.is_uppercase() && i > 0 {
            let prev = name.as_bytes()[i - 1];
            if !prev.is_ascii_uppercase() {
                out.push('_');
            }
        }
        out.push(ch.to_ascii_lowercase());
    }
    out
}

/// Build the SDK's discover-time schema from registered factories.
///
/// `edges` and `relations` are emitted as empty lists. They were populated
/// from FK introspection in the old design; here the create payload's
/// `_alias`/`_ref` graph carries equivalent information at request time.
pub fn build_schema_from_factories(
    factories: &FactoryRegistry,
    scope_field: &str,
) -> SchemaInfo {
    let mut models: Vec<ModelInfo> = Vec::new();

    for (entity, factory) in factories {
        // Every model gets a synthetic `id` field at the head.
        let mut fields: Vec<FieldInfo> = vec![FieldInfo {
            name: "id".to_string(),
            field_type: "string".to_string(),
            is_required: false,
            is_id: true,
            has_default: true,
        }];

        for fd in &factory.input_fields {
            fields.push(FieldInfo {
                name: fd.name.clone(),
                field_type: fd.field_type.clone(),
                is_required: fd.required,
                is_id: false,
                has_default: !fd.required,
            });
        }

        models.push(ModelInfo {
            name: entity.clone(),
            table_name: camel_to_snake(entity),
            fields,
        });
    }

    SchemaInfo {
        models,
        edges: vec![],
        relations: vec![],
        scope_field: scope_field.to_string(),
    }
}

/// Serialise a `SchemaInfo` to the JSON shape the dashboard expects.
pub fn schema_to_wire(schema: &SchemaInfo) -> Value {
    json!({
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
                        "hasDefault": f.has_default,
                    })
                }).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>(),
        "edges": schema.edges.iter().map(|e| {
            json!({
                "from": e.from_model,
                "to": e.to_model,
                "localField": e.local_field,
                "foreignField": e.foreign_field,
                "nullable": e.nullable,
            })
        }).collect::<Vec<_>>(),
        "relations": schema.relations.iter().map(|r| {
            json!({
                "parentModel": r.parent_model,
                "childModel": r.child_model,
                "parentField": r.parent_field,
                "childField": r.child_field,
            })
        }).collect::<Vec<_>>(),
        "scopeField": schema.scope_field,
    })
}
