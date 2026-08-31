//! Structured errors for Autonoma protocol responses.
//!
//! Each error carries a stable `code` and HTTP `status` that flow across the
//! wire unchanged, so the platform can react to a failure class regardless of
//! which language SDK produced it.

use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct AutonomaError {
    pub message: String,
    pub code: String,
    pub status: u16,
}

impl std::fmt::Display for AutonomaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AutonomaError {}

impl AutonomaError {
    pub fn to_body(&self) -> Value {
        json!({
            "error": self.message,
            "code": self.code,
        })
    }
}

pub fn unknown_action(action: &str) -> AutonomaError {
    AutonomaError {
        message: format!("Unknown action: {}", action),
        code: "UNKNOWN_ACTION".to_string(),
        status: 400,
    }
}

/// Returned by `up` when the request names a scenario that is not registered.
pub fn unknown_environment(name: &str) -> AutonomaError {
    AutonomaError {
        message: format!("Unknown environment: {}", name),
        code: "UNKNOWN_ENVIRONMENT".to_string(),
        status: 400,
    }
}

pub fn invalid_signature() -> AutonomaError {
    AutonomaError {
        message: "Invalid HMAC signature".to_string(),
        code: "INVALID_SIGNATURE".to_string(),
        status: 401,
    }
}

pub fn invalid_teardown_token(reason: &str) -> AutonomaError {
    AutonomaError {
        message: format!("Invalid teardown token: {}", reason),
        code: "INVALID_TEARDOWN_TOKEN".to_string(),
        status: 403,
    }
}

/// Deprecated: the SDK no longer gates on production, so this error is never
/// returned. HMAC signing is the gate.
#[deprecated(note = "the SDK no longer gates on production; this error is never returned")]
pub fn production_blocked(reason: &str) -> AutonomaError {
    AutonomaError {
        message: format!("Environment factory is disabled. {}", reason),
        code: "PRODUCTION_BLOCKED".to_string(),
        status: 404,
    }
}

pub fn invalid_body(reason: &str) -> AutonomaError {
    AutonomaError {
        message: format!("Invalid request body: {}", reason),
        code: "INVALID_BODY".to_string(),
        status: 400,
    }
}

pub fn same_secrets() -> AutonomaError {
    AutonomaError {
        message: "sharedSecret and signingSecret must be different. The shared secret is known by Autonoma; the signing secret must be private.".to_string(),
        code: "SAME_SECRETS".to_string(),
        status: 500,
    }
}
