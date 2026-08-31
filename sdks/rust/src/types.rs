//! Type definitions for the Autonoma SDK (Scenario v2).
//!
//! A host app registers named scenarios (the [`crate::scenario::Scenario`]
//! trait). The platform calls `up` with only a scenario name + `testRunId`;
//! the scenario runs free-form async code and returns optional
//! `auth`/`teardown`. The SDK owns the envelope: `teardownToken` signing,
//! expiry defaults, and the protocol `version` field.
//!
//! The factory types near the bottom survive as an optional helper library a
//! scenario's `up`/`down` may use internally (see `factory.rs`); they are no
//! longer wired to the wire protocol.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use crate::errors::AutonomaError;
use crate::scenario::Scenario;

// ---------------------------------------------------------------------------
// SDK identity metadata
// ---------------------------------------------------------------------------

/// SDK metadata echoed on every wire response; server adapters populate it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SdkMeta {
    pub orm: String,
    pub server: String,
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/// A single cookie a test runner sets to act as the seeded user.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AuthCookie {
    pub name: String,
    pub value: String,
    #[serde(rename = "httpOnly", skip_serializing_if = "Option::is_none")]
    pub http_only: Option<bool>,
    #[serde(rename = "sameSite", skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secure: Option<bool>,
    #[serde(rename = "maxAge", skip_serializing_if = "Option::is_none")]
    pub max_age: Option<i64>,
}

/// Credentials the test runner uses to act as the seeded user. A scenario's
/// `up` returns it; the SDK echoes it on `up` verbatim.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AuthResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cookies: Option<Vec<AuthCookie>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credentials: Option<HashMap<String, String>>,
}

// ---------------------------------------------------------------------------
// Scenario authoring surface
// ---------------------------------------------------------------------------

/// Context passed to a scenario's `up`.
pub struct ScenarioUpContext {
    /// Unique id for this test run. Seed the uniqueness helpers
    /// (`unique_email`, `unique_slug`, ...) from it so values are unique per
    /// run yet reproducible between `up` and `down`.
    pub test_run_id: String,
}

/// What a scenario's `up` returns. Every field is optional.
#[derive(Debug, Clone, Default)]
pub struct ScenarioUpResult {
    /// Credentials the test runner uses to act as the seeded user.
    pub auth: Option<AuthResult>,
    /// Opaque handles carried inside the signed teardown token and handed back
    /// to `down` verbatim, so a scenario can carry what it needs to tear itself
    /// down.
    pub teardown: Option<Value>,
}

/// Context passed to a scenario's `down`.
pub struct ScenarioDownContext {
    /// The scenario name, recovered from the verified teardown token.
    pub name: String,
    /// The `teardown` handle this scenario returned from `up`.
    pub teardown: Value,
    /// The `testRunId` captured at `up` time.
    pub test_run_id: String,
}

// ---------------------------------------------------------------------------
// Handler config and request/response
// ---------------------------------------------------------------------------

/// Configuration for the Autonoma request handler.
pub struct HandlerConfig {
    /// Known by both you and Autonoma; verifies HMAC signatures.
    pub shared_secret: String,
    /// Private to you; signs the teardown token.
    pub signing_secret: String,
    /// Every scenario the platform can run.
    pub scenarios: Vec<Box<dyn Scenario>>,
    /// The token/environment lifetime returned on `up` as `expiresInSeconds`.
    /// Defaults to 3600 (one hour) when `None`.
    pub expires_in_seconds: Option<u64>,
    #[deprecated(
        note = "ignored; the endpoint is always enabled and HMAC signing is the gate. On Autonoma previews (AUTONOMA_PREVIEWKIT set) no guard is needed; gate manually in your handler for your own production deployments"
    )]
    pub allow_production: bool,
    /// Optional identity metadata; server adapters populate it.
    pub sdk: Option<SdkMeta>,
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

// ---------------------------------------------------------------------------
// Optional factory library (not wired to the wire protocol in v2)
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

/// Context passed to factory create/teardown functions. Factories that need a
/// database connection get it from the host (their own connection pool, ORM,
/// etc.); the SDK provides `refs` and `test_run_id` only.
pub struct FactoryContext {
    /// Every record created so far, keyed by model name.
    pub refs: HashMap<String, Vec<serde_json::Map<String, Value>>>,
    pub scenario_name: String,
    pub test_run_id: String,
}

/// A factory for creating and optionally tearing down entities for one model.
///
/// Factories are an optional helper library a scenario's `up`/`down` may use;
/// they are NOT wired to the wire protocol in v2.
pub struct FactoryDefinition {
    pub input_fields: Vec<FieldDef>,
    pub create_fn: Box<
        dyn for<'a> Fn(
                &'a serde_json::Map<String, Value>,
                &'a FactoryContext,
            ) -> Pin<
                Box<
                    dyn Future<Output = Result<serde_json::Map<String, Value>, AutonomaError>>
                        + Send
                        + 'a,
                >,
            > + Send
            + Sync,
    >,
    pub teardown_fn: Option<
        Box<
            dyn for<'a> Fn(
                    &'a serde_json::Map<String, Value>,
                    &'a FactoryContext,
                )
                    -> Pin<Box<dyn Future<Output = Result<(), AutonomaError>> + Send + 'a>>
                + Send
                + Sync,
        >,
    >,
    pub ref_fields: Option<Vec<FieldDef>>,
}

/// Registry mapping model names to their factory definitions.
pub type FactoryRegistry = HashMap<String, FactoryDefinition>;
