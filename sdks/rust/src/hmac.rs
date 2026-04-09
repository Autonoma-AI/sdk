//! HMAC-SHA256 signing and verification for request authentication.

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Sign a body string with a secret using HMAC-SHA256. Returns 64-char lowercase hex.
pub fn sign_body(body: &str, secret: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC can take key of any size");
    mac.update(body.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Verify a signature using constant-time comparison.
pub fn verify_signature(body: &str, signature: &str, secret: &str) -> bool {
    let expected = sign_body(body, secret);
    constant_time_eq(expected.as_bytes(), signature.as_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_body_returns_64_char_hex() {
        let sig = sign_body(r#"{"action":"discover"}"#, "test-secret");
        assert_eq!(sig.len(), 64);
        assert!(sig.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn verify_round_trip() {
        let body = r#"{"action":"discover"}"#;
        let secret = "my-secret";
        let sig = sign_body(body, secret);
        assert!(verify_signature(body, &sig, secret));
    }

    #[test]
    fn verify_rejects_wrong_signature() {
        assert!(!verify_signature("body", "wrong", "secret"));
    }
}
