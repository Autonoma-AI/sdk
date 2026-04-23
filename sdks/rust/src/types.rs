//! Type definitions for Autonoma SDK.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use crate::errors::AutonomaError;

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

/// Minimal SQL executor — wrap your DB connection into this.
#[async_trait]
pub trait SqlExecutor: Send + Sync {
    async fn query(
        &self,
        sql: &str,
        params: Option<&[Value]>,
    ) -> Result<Vec<HashMap<String, Value>>, String>;

    async fn transaction(
        &self,
        f: Box<dyn for<'a> FnOnce(&'a dyn SqlExecutor) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> + Send>,
    ) -> Result<(), String>;
}

/// Context passed to handler hooks (before_down, after_up).
pub struct HookContext {
    pub scenario_name: String,
    pub refs: HashMap<String, Vec<HashMap<String, Value>>>,
}

/// Context passed to the auth callback alongside the user record.
pub struct AuthContext<'a> {
    pub scope_value: &'a str,
    pub refs: &'a HashMap<String, Vec<HashMap<String, Value>>>,
}

/// Configuration for the Autonoma request handler.
pub struct HandlerConfig {
    pub executor: Box<dyn SqlExecutor>,
    pub scope_field: String,
    pub shared_secret: String,
    pub signing_secret: String,
    pub auth: Box<dyn Fn(Option<&HashMap<String, Value>>, &AuthContext<'_>) -> HashMap<String, Value> + Send + Sync>,
    pub dialect: String,
    pub db_schema: Option<String>,
    pub table_name_map: Option<HashMap<String, String>>,
    pub exclude_tables: Option<Vec<String>>,
    pub allow_production: bool,
    pub sdk: Option<SdkMeta>,
    /// Cached introspection result (populated on first request).
    /// Initialize with `tokio::sync::OnceCell::new()`.
    pub introspection_cache: tokio::sync::OnceCell<IntrospectionResult>,
    /// Optional hook called before teardown in `down`.
    pub before_down: Option<Box<dyn Fn(&HookContext) + Send + Sync>>,
    /// Optional hook called after entity creation and auth in `up`.
    pub after_up: Option<Box<dyn Fn(&HookContext, HashMap<String, Value>) -> HashMap<String, Value> + Send + Sync>>,
    /// Factory definitions per model. If a factory exists for a model, it is used instead of raw SQL INSERT.
    pub factories: Option<FactoryRegistry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SdkMeta {
    pub orm: String,
    pub server: String,
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

/// A create operation produced by the tree resolver.
#[derive(Debug, Clone)]
pub struct CreateOp {
    pub model: String,
    pub fields: HashMap<String, Value>,
    pub temp_id: String,
    pub batch: bool,
}

/// A deferred FK update for circular dependencies.
#[derive(Debug, Clone)]
pub struct DeferredUpdate {
    pub target_temp_id: String,
    pub model: String,
    pub field: String,
    pub ref_alias: String,
}

/// Result of database introspection.
#[derive(Debug, Clone)]
pub struct IntrospectionResult {
    pub schema: SchemaInfo,
    pub table_map: HashMap<String, String>,
    pub column_maps: HashMap<String, HashMap<String, String>>,
    pub enum_type_maps: HashMap<String, HashMap<String, String>>,
}

/// Context passed to factory create/teardown functions.
pub struct FactoryContext<'a> {
    pub refs: &'a HashMap<String, Vec<HashMap<String, Value>>>,
    pub executor: &'a dyn SqlExecutor,
    pub scenario_name: String,
    pub test_run_id: String,
}

/// User-defined factory for creating entities via custom code instead of raw SQL.
///
/// Implement this trait to register a factory for a model. The SDK will call
/// `create()` instead of raw SQL INSERT for models with registered factories.
#[async_trait]
pub trait Factory: Send + Sync {
    /// Create a single entity. Receives pre-resolved fields (temp IDs already replaced).
    /// Must return at least the primary key field.
    async fn create(
        &self,
        data: HashMap<String, Value>,
        ctx: &FactoryContext<'_>,
    ) -> Result<HashMap<String, Value>, AutonomaError>;

    /// Optional teardown per record. Return `Err` with code `NO_FACTORY_TEARDOWN`
    /// to signal that SQL DELETE should be used instead.
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

    /// Whether this factory has a custom teardown. If false, SQL DELETE is used.
    fn has_teardown(&self) -> bool {
        false
    }
}

/// Registry mapping model names to their factory implementations.
pub type FactoryRegistry = HashMap<String, Box<dyn Factory>>;
