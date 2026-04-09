//! Structured errors for Autonoma protocol responses.

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
            "code": self.code
        })
    }
}

pub fn invalid_signature() -> AutonomaError {
    AutonomaError {
        message: "Invalid signature".to_string(),
        code: "INVALID_SIGNATURE".to_string(),
        status: 401,
    }
}

pub fn invalid_body(detail: &str) -> AutonomaError {
    AutonomaError {
        message: format!("Invalid body: {}", detail),
        code: "INVALID_BODY".to_string(),
        status: 400,
    }
}

pub fn unknown_action(action: &str) -> AutonomaError {
    AutonomaError {
        message: format!("Unknown action: {}", action),
        code: "UNKNOWN_ACTION".to_string(),
        status: 400,
    }
}

pub fn production_blocked() -> AutonomaError {
    AutonomaError {
        message: "Blocked in production".to_string(),
        code: "PRODUCTION_BLOCKED".to_string(),
        status: 404,
    }
}

pub fn invalid_refs_token(detail: &str) -> AutonomaError {
    AutonomaError {
        message: format!("Invalid refs token: {}", detail),
        code: "INVALID_REFS_TOKEN".to_string(),
        status: 403,
    }
}

pub fn same_secrets() -> AutonomaError {
    AutonomaError {
        message: "sharedSecret and signingSecret must be different. The shared secret is known by Autonoma; the signing secret must be private.".to_string(),
        code: "SAME_SECRETS".to_string(),
        status: 500,
    }
}
