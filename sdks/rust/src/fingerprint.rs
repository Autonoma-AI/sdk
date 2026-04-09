//! Deterministic SHA256-based fingerprinting of scenario definitions.

use serde_json::Value;
use sha2::{Digest, Sha256};

/// Compute a 16-char hex fingerprint of any JSON-serializable value.
pub fn fingerprint(value: &Value) -> String {
    let normalized = sort_keys(value);
    let json_str = compact_json(&normalized);
    let hash = Sha256::digest(json_str.as_bytes());
    hex::encode(hash)[..16].to_string()
}

fn sort_keys(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted: Vec<(String, Value)> = map
                .iter()
                .map(|(k, v)| (k.clone(), sort_keys(v)))
                .collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(arr) => Value::Array(arr.iter().map(sort_keys).collect()),
        other => other.clone(),
    }
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn produces_16_char_hex() {
        let fp = fingerprint(&json!({"a": 1}));
        assert_eq!(fp.len(), 16);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn order_independent() {
        let fp1 = fingerprint(&json!({"a": 1, "b": 2}));
        let fp2 = fingerprint(&json!({"b": 2, "a": 1}));
        assert_eq!(fp1, fp2);
    }

    #[test]
    fn different_data_different_hash() {
        let fp1 = fingerprint(&json!({"a": 1}));
        let fp2 = fingerprint(&json!({"a": 2}));
        assert_ne!(fp1, fp2);
    }
}
