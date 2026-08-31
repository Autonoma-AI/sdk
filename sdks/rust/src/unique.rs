//! Deterministic uniqueness helpers seeded from `testRunId`.
//!
//! A scenario's data needs stable keys across runs but unique values per run
//! (unique emails, org slugs, ids). These derive that uniqueness from
//! `(testRunId, ...parts)`: the same inputs always produce the same output
//! within a run, so a scenario's `up` and a later `down` compute identical
//! values without storing them.
//!
//! The recipe is `sha256(testRunId + (" " + part) for each part)`, hex-encoded,
//! truncated to the first 12 chars - and MUST match the other language SDKs
//! byte-for-byte for cross-language conformance.

use regex::Regex;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const TOKEN_LENGTH: usize = 12;

fn slug_non_alnum() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[^a-z0-9]+").unwrap())
}

fn slug_trim_hyphens() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^-+|-+$").unwrap())
}

fn digest(test_run_id: &str, parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(test_run_id.as_bytes());
    for part in parts {
        hasher.update(b" ");
        hasher.update(part.as_bytes());
    }
    hex::encode(hasher.finalize())
}

/// A short hex token, deterministic per `(testRunId, ...parts)`.
pub fn unique_token(test_run_id: &str, parts: &[&str]) -> String {
    digest(test_run_id, parts)[..TOKEN_LENGTH].to_string()
}

/// A unique id like `user_1a2b3c4d5e6f`, deterministic per inputs. An empty
/// prefix defaults to `id`.
pub fn unique_id(test_run_id: &str, prefix: &str, parts: &[&str]) -> String {
    let prefix = if prefix.is_empty() { "id" } else { prefix };
    let mut token_parts = vec![prefix];
    token_parts.extend_from_slice(parts);
    format!("{}_{}", prefix, unique_token(test_run_id, &token_parts))
}

/// A URL-safe slug like `acme-1a2b3c4d5e6f`, deterministic per inputs. An empty
/// base defaults to `item`.
pub fn unique_slug(test_run_id: &str, base: &str, parts: &[&str]) -> String {
    let base = if base.is_empty() { "item" } else { base };
    let mut token_parts = vec![base];
    token_parts.extend_from_slice(parts);
    let token = unique_token(test_run_id, &token_parts);

    let lowered = base.to_lowercase();
    let hyphenated = slug_non_alnum().replace_all(&lowered, "-");
    let normalized = slug_trim_hyphens().replace_all(&hyphenated, "");
    let normalized = if normalized.is_empty() {
        "item"
    } else {
        &normalized
    };
    format!("{}-{}", normalized, token)
}

/// A unique email like `user+1a2b3c4d5e6f@example.com`, deterministic per
/// inputs. Empty local/domain default to `user`/`example.com`.
pub fn unique_email(test_run_id: &str, local: &str, domain: &str) -> String {
    let local = if local.is_empty() { "user" } else { local };
    let domain = if domain.is_empty() {
        "example.com"
    } else {
        domain
    };
    format!(
        "{}+{}@{}",
        local,
        unique_token(test_run_id, &[local, domain]),
        domain
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cross-checked against the TypeScript `unique.ts` recipe so the same
    // (testRunId, ...parts) yields byte-identical output across languages.
    #[test]
    fn cross_language_vectors() {
        assert_eq!(unique_token("run-1", &[]), "4e65d3fbe8ad");
        assert_eq!(unique_email("run-1", "", ""), "user+039af36014b8@example.com");
        assert_eq!(unique_slug("run-1", "Acme", &[]), "acme-b6446df155f8");
        assert_eq!(unique_id("run-1", "user", &[]), "user_776b5cbfd0f0");
    }

    #[test]
    fn token_shape() {
        let token = unique_token("run", &["a", "b"]);
        assert_eq!(token.len(), 12);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn deterministic_and_seeded() {
        assert_eq!(unique_token("run", &["x"]), unique_token("run", &["x"]));
        assert_ne!(unique_token("run-a", &["x"]), unique_token("run-b", &["x"]));
        assert_ne!(unique_token("run", &["x"]), unique_token("run", &["y"]));
    }

    #[test]
    fn slug_normalization() {
        let slug = unique_slug("run", "Acme Corp!!", &[]);
        assert!(Regex::new(r"^acme-corp-[0-9a-f]{12}$").unwrap().is_match(&slug));
        // A base that normalizes to empty falls back to "item".
        let slug = unique_slug("run", "!!!", &[]);
        assert!(Regex::new(r"^item-[0-9a-f]{12}$").unwrap().is_match(&slug));
    }
}
