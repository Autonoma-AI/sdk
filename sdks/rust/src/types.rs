//! Type definitions for Autonoma SDK.
//!
//! The SDK is factory-driven: every model is owned by a registered factory
//! whose input is described by `Vec<FieldDef>`. There is no SQL introspection,
//! no executor protocol, and no dialect machinery.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use crate::errors::AutonomaError;

// ---------------------------------------------------------------------------
// Wire-shape types (discover response)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(rename = "isRequired")]
    pub is_required: bool,
    #[serde(rename = "isId")]
    pub is_id: bool,
    #[serde(rename = "hasDefault")]
    pub has_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub name: String,
    #[serde(rename = "tableName")]
    pub table_name: String,
    pub fields: Vec<FieldInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FKEdge {
    #[serde(rename = "from")]
    pub from_model: String,
    #[serde(rename = "to")]
    pub to_model: String,
    #[serde(rename = "localField")]
    pub local_field: String,
    #[serde(rename = "foreignField")]
    pub foreign_field: String,
    pub nullable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaRelation {
    #[serde(rename = "parentModel")]
    pub parent_model: String,
    #[serde(rename = "childModel")]
    pub child_model: String,
    #[serde(rename = "parentField")]
    pub parent_field: String,
    #[serde(rename = "childField")]
    pub child_field: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaInfo {
    pub models: Vec<ModelInfo>,
    pub edges: Vec<FKEdge>,
    pub relations: Vec<SchemaRelation>,
    #[serde(rename = "scopeField")]
    pub scope_field: String,
}

// ---------------------------------------------------------------------------
// Factory field definition (replaces Pydantic input_model)
// ---------------------------------------------------------------------------

/// Describes a single field on a factory's input.
///
/// Types are SDK type strings: "string", "integer", "number", "boolean",
/// "timestamp", "date", "uuid", "json".
#[derive(Debug, Clone)]
pub struct FieldDef {
    pub name: String,
    pub field_type: String,
    pub required: bool,
}

// ---------------------------------------------------------------------------
// Create operation (produced by payload_topo)
// ---------------------------------------------------------------------------

/// A create operation produced by the payload topo resolver.
#[derive(Debug, Clone)]
pub struct CreateOp {
    pub model: String,
    pub fields: serde_json::Map<String, Value>,
    pub temp_id: String,
}

/// Output of `resolve_payload_tree`.
#[derive(Debug, Clone)]
pub struct ResolvedTree {
    pub ops: Vec<CreateOp>,
    /// alias -> temp_id
    pub aliases: HashMap<String, String>,
    /// alias -> model name
    pub alias_owner_model: HashMap<String, String>,
    /// alias -> list of dependency alias names
    pub alias_dependencies: HashMap<String, Vec<String>>,
}

// ---------------------------------------------------------------------------
// Factory definition
// ---------------------------------------------------------------------------

/// A factory for creating entities via user code.
///
/// `input_fields` is required: the SDK validates the resolved field dict
/// against it before invoking `create`, and uses it to build the discover
/// schema. `ref_fields` is optional; when provided, the SDK validates
/// the stored record against it before invoking `teardown`.
pub struct FactoryDefinition {
    pub input_fields: Vec<FieldDef>,
    pub create_fn: Box<
        dyn for<'a> Fn(
                &'a serde_json::Map<String, Value>,
                &'a FactoryContext,
            ) -> Pin<Box<dyn Future<Output = Result<serde_json::Map<String, Value>, AutonomaError>> + Send + 'a>>
            + Send
            + Sync,
    >,
    pub teardown_fn: Option<
        Box<
            dyn for<'a> Fn(
                    &'a serde_json::Map<String, Value>,
                    &'a FactoryContext,
                ) -> Pin<Box<dyn Future<Output = Result<(), AutonomaError>> + Send + 'a>>
                + Send
                + Sync,
        >,
    >,
    pub ref_fields: Option<Vec<FieldDef>>,
}

/// Registry mapping model names to their factory definitions.
pub type FactoryRegistry = HashMap<String, FactoryDefinition>;

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

/// Context passed to factory create/teardown functions.
///
/// Factories that need a database connection get it from the host (their
/// own connection pool, ORM, etc.). The SDK provides `refs` and
/// `test_run_id` only.
pub struct FactoryContext {
    pub refs: HashMap<String, Vec<serde_json::Map<String, Value>>>,
    pub scenario_name: String,
    pub test_run_id: String,
}

/// Context passed to handler hooks (before_down, after_up).
pub struct HookContext {
    pub scenario_name: String,
    pub refs: HashMap<String, Vec<serde_json::Map<String, Value>>>,
}

/// Context passed to the auth callback alongside the user record.
pub struct AuthContext<'a> {
    pub scope_value: &'a str,
    pub refs: &'a HashMap<String, Vec<serde_json::Map<String, Value>>>,
}

// ---------------------------------------------------------------------------
// Handler config and request/response
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SdkMeta {
    pub orm: String,
    pub server: String,
}

/// Configuration for the Autonoma request handler.
pub struct HandlerConfig {
    pub scope_field: String,
    pub shared_secret: String,
    pub signing_secret: String,
    pub auth: Box<
        dyn for<'a> Fn(
                Option<&'a serde_json::Map<String, Value>>,
                &'a AuthContext<'a>,
            ) -> Pin<Box<dyn Future<Output = HashMap<String, Value>> + Send + 'a>>
            + Send
            + Sync,
    >,
    pub factories: FactoryRegistry,
    pub allow_production: bool,
    pub sdk: Option<SdkMeta>,
    /// Optional hook called before teardown in `down`.
    pub before_down: Option<
        Box<dyn Fn(&HookContext) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> + Send + Sync>,
    >,
    /// Optional hook called after entity creation and auth in `up`.
    pub after_up: Option<
        Box<
            dyn Fn(
                    &HookContext,
                    HashMap<String, Value>,
                ) -> Pin<Box<dyn Future<Output = HashMap<String, Value>> + Send + '_>>
                + Send
                + Sync,
        >,
    >,
}

#[derive(Debug, Clone)]
pub struct HandlerRequest {
    pub body: String,
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HandlerResponse {
    pub status: u16,
    pub body: Value,
}
