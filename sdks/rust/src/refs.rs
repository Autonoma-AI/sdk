//! JWT-like refs token: header.payload.signature using HMAC-SHA256.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Sign a refs payload into a 3-part token string.
pub fn sign_refs(payload: &Value, secret: &str) -> String {
    let header_json = r#"{"alg":"HS256","typ":"REFS"}"#;
    let header = base64url_encode(header_json.as_bytes());

    let body_json = compact_json(payload);
    let body = base64url_encode(body_json.as_bytes());

    let signature = hmac_sign(&format!("{}.{}", header, body), secret);
    format!("{}.{}.{}", header, body, signature)
}

/// Verify and decode a refs token. Returns the payload or an error.
pub fn verify_refs(token: &str, secret: &str) -> Result<Value, String> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err("malformed token".to_string());
    }

    let (header, body, signature) = (parts[0], parts[1], parts[2]);
    let expected = hmac_sign(&format!("{}.{}", header, body), secret);

    if expected != signature {
        return Err("signature mismatch".to_string());
    }

    let decoded = base64url_decode(body)?;
    let payload: Value =
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

/// Compact JSON serialization (no spaces).
fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sign_refs_produces_three_part_token() {
        let token = sign_refs(&json!({"test": true}), "secret");
        assert_eq!(token.split('.').count(), 3);
    }

    #[test]
    fn round_trip() {
        let payload = json!({"refs": {"User": [{"id": "abc"}]}, "testRunId": "run-1"});
        let token = sign_refs(&payload, "secret");
        let decoded = verify_refs(&token, "secret").unwrap();
        assert_eq!(decoded, payload);
    }

    #[test]
    fn rejects_wrong_secret() {
        let token = sign_refs(&json!({"test": true}), "secret1");
        assert!(verify_refs(&token, "secret2").is_err());
    }
}
