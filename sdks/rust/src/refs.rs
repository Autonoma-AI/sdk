//! JWT-like teardown token: header.payload.signature using HMAC-SHA256.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// The payload signed into the teardown token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefsPayload {
    /// Whatever a scenario's `up` returned as `refs` - arbitrary JSON, signed
    /// at `up` and handed back to `down` verbatim.
    #[serde(default)]
    pub refs: Value,
    /// The `testRunId` captured at `up` time.
    #[serde(rename = "testRunId", default)]
    pub test_run_id: String,
    /// The scenario name. Named `environment` for wire/back-compat reasons;
    /// `down` reads it to route to the right scenario's teardown.
    #[serde(default)]
    pub environment: String,
}

/// Sign a refs payload into a 3-part token string (header.payload.signature).
pub fn sign_refs(payload: &RefsPayload, secret: &str) -> String {
    let header_json = r#"{"alg":"HS256","typ":"REFS"}"#;
    let header = base64url_encode(header_json.as_bytes());

    let body_json = serde_json::to_string(payload).unwrap_or_default();
    let body = base64url_encode(body_json.as_bytes());

    let signature = hmac_sign(&format!("{}.{}", header, body), secret);
    format!("{}.{}.{}", header, body, signature)
}

/// Verify and decode a teardown token. Returns the payload or an error.
pub fn verify_refs(token: &str, secret: &str) -> Result<RefsPayload, String> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err("malformed token".to_string());
    }

    let (header, body, signature) = (parts[0], parts[1], parts[2]);
    let expected = hmac_sign(&format!("{}.{}", header, body), secret);

    if !crate::hmac::constant_time_eq(expected.as_bytes(), signature.as_bytes()) {
        return Err("signature mismatch".to_string());
    }

    let decoded = base64url_decode(body)?;
    let payload: RefsPayload =
        serde_json::from_slice(&decoded).map_err(|e| format!("invalid payload: {}", e))?;
    Ok(payload)
}

fn base64url_encode(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

fn base64url_decode(data: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(data)
        .map_err(|e| format!("base64 decode error: {}", e))
}

fn hmac_sign(data: &str, secret: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC can take key of any size");
    mac.update(data.as_bytes());
    base64url_encode(&mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload() -> RefsPayload {
        RefsPayload {
            refs: json!({ "userId": "user-1", "nested": { "count": 3 } }),
            test_run_id: "test-run-123".to_string(),
            environment: "standard".to_string(),
        }
    }

    #[test]
    fn sign_refs_produces_three_part_token() {
        let token = sign_refs(&payload(), "signing-secret");
        assert_eq!(token.split('.').count(), 3);
    }

    #[test]
    fn round_trip() {
        let token = sign_refs(&payload(), "signing-secret");
        let decoded = verify_refs(&token, "signing-secret").unwrap();
        assert_eq!(decoded.test_run_id, "test-run-123");
        assert_eq!(decoded.environment, "standard");
        assert_eq!(decoded.refs["userId"], "user-1");
        assert_eq!(decoded.refs["nested"]["count"], 3);
    }

    #[test]
    fn rejects_wrong_secret() {
        let token = sign_refs(&payload(), "right-secret");
        assert!(verify_refs(&token, "wrong-secret").is_err());
    }

    #[test]
    fn rejects_malformed_token() {
        assert!(verify_refs("only-one-part", "signing-secret").is_err());
    }

    #[test]
    fn rejects_tampered_payload() {
        let token = sign_refs(&payload(), "signing-secret");
        let parts: Vec<&str> = token.split('.').collect();
        let tampered = format!("{}.dGFtcGVyZWQ.{}", parts[0], parts[2]);
        assert!(verify_refs(&tampered, "signing-secret").is_err());
    }
}
