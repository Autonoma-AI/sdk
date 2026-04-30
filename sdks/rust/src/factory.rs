//! Factory definition helper.
//!
//! The SDK is factory-driven: every model the dashboard can create is owned
//! by a registered factory. `input_fields` is required — it is what the SDK
//! uses to validate inputs before calling `create` and to populate the
//! discover schema.

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

use crate::errors::AutonomaError;
use crate::types::{FactoryContext, FactoryDefinition, FieldDef};

/// Define a factory for an entity.
///
/// # Arguments
///
/// * `input_fields` - Required. Describes the fields the factory accepts.
///   The SDK validates the resolved field dict against these before calling
///   `create`, and uses them to build the discover schema.
/// * `create` - Async closure that creates a single entity. Must return a
///   `Map<String, Value>` with at least an `"id"` key.
/// * `teardown` - Optional async closure that tears down a single entity.
/// * `ref_fields` - Optional. When provided, describes the shape of records
///   stored in refs (used for teardown validation).
///
/// # Example
///
/// ```ignore
/// let user_factory = define_factory(
///     vec![
///         FieldDef { name: "email".into(), field_type: "string".into(), required: true },
///         FieldDef { name: "name".into(), field_type: "string".into(), required: false },
///     ],
///     |data, ctx| Box::pin(async move {
///         let mut record = serde_json::Map::new();
///         record.insert("id".into(), Value::String("123".into()));
///         record.insert("email".into(), data.get("email").cloned().unwrap_or(Value::Null));
///         Ok(record)
///     }),
///     Some(|record: &serde_json::Map<String, Value>, ctx: &FactoryContext| Box::pin(async move {
///         // delete logic
///         Ok(())
///     })),
///     None,
/// );
/// ```
pub fn define_factory<C, T>(
    input_fields: Vec<FieldDef>,
    create: C,
    teardown: Option<T>,
    ref_fields: Option<Vec<FieldDef>>,
) -> FactoryDefinition
where
    C: for<'a> Fn(
            &'a serde_json::Map<String, Value>,
            &'a FactoryContext,
        ) -> Pin<Box<dyn Future<Output = Result<serde_json::Map<String, Value>, AutonomaError>> + Send + 'a>>
        + Send
        + Sync
        + 'static,
    T: for<'a> Fn(
            &'a serde_json::Map<String, Value>,
            &'a FactoryContext,
        ) -> Pin<Box<dyn Future<Output = Result<(), AutonomaError>> + Send + 'a>>
        + Send
        + Sync
        + 'static,
{
    if input_fields.is_empty() {
        // Allow empty input_fields — some models have no user-supplied fields
        // and only produce a generated id.
    }

    FactoryDefinition {
        input_fields,
        create_fn: Box::new(create),
        teardown_fn: teardown.map(|f| {
            Box::new(f)
                as Box<
                    dyn for<'a> Fn(
                            &'a serde_json::Map<String, Value>,
                            &'a FactoryContext,
                        )
                            -> Pin<Box<dyn Future<Output = Result<(), AutonomaError>> + Send + 'a>>
                        + Send
                        + Sync,
                >
        }),
        ref_fields,
    }
}

/// Define a factory with no teardown and no ref_fields.
///
/// This is a convenience wrapper around `define_factory` that avoids the
/// need to spell out the teardown closure type for `None`.
pub fn define_factory_create_only<C>(
    input_fields: Vec<FieldDef>,
    create: C,
) -> FactoryDefinition
where
    C: for<'a> Fn(
            &'a serde_json::Map<String, Value>,
            &'a FactoryContext,
        ) -> Pin<Box<dyn Future<Output = Result<serde_json::Map<String, Value>, AutonomaError>> + Send + 'a>>
        + Send
        + Sync
        + 'static,
{
    FactoryDefinition {
        input_fields,
        create_fn: Box::new(create),
        teardown_fn: None,
        ref_fields: None,
    }
}

/// Validate a field map against a factory's input_fields.
///
/// Checks that all required fields are present. Returns an error message
/// listing the missing fields, or `Ok(())` if validation passes.
pub fn validate_input(
    fields: &serde_json::Map<String, Value>,
    input_fields: &[FieldDef],
) -> Result<(), String> {
    let missing: Vec<&str> = input_fields
        .iter()
        .filter(|fd| fd.required && !fields.contains_key(&fd.name))
        .map(|fd| fd.name.as_str())
        .collect();

    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("missing required fields: {}", missing.join(", ")))
    }
}
