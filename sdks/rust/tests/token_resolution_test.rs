//! Defense-in-depth token resolution tests.

use autonoma_sdk::handler::resolve_tokens;
use serde_json::{json, Value};

#[test]
fn testrunid_substituted() {
    let out = resolve_tokens(&json!({"email": "alice-{{testRunId}}@test.local"}), "run-123", 0).unwrap();
    assert_eq!(out, json!({"email": "alice-run-123@test.local"}));
}

#[test]
fn index_substituted() {
    let out = resolve_tokens(&json!({"slot": "pos-{{index}}"}), "r", 4).unwrap();
    assert_eq!(out, json!({"slot": "pos-4"}));
}

#[test]
fn cycle_substituted_and_wraps() {
    assert_eq!(resolve_tokens(&json!("{{cycle(a,b)}}"), "r", 0).unwrap(), json!("a"));
    assert_eq!(resolve_tokens(&json!("{{cycle(a,b)}}"), "r", 1).unwrap(), json!("b"));
    assert_eq!(resolve_tokens(&json!("{{cycle(a,b)}}"), "r", 2).unwrap(), json!("a"));
}

#[test]
fn cycle_quoted_values_stripped() {
    assert_eq!(
        resolve_tokens(&json!("{{cycle('WEB','IOS','ANDROID')}}"), "r", 1).unwrap(),
        json!("IOS")
    );
}

#[test]
fn nested_structures_walked() {
    let input = json!({
        "users": [
            {"email": "u-{{testRunId}}@t.local"},
            {"email": "v-{{testRunId}}@t.local"}
        ],
        "tags": ["{{testRunId}}-a", "{{testRunId}}-b"]
    });
    let expected = json!({
        "users": [
            {"email": "u-xyz@t.local"},
            {"email": "v-xyz@t.local"}
        ],
        "tags": ["xyz-a", "xyz-b"]
    });
    assert_eq!(resolve_tokens(&input, "xyz", 0).unwrap(), expected);
}

#[test]
fn multiple_tokens_in_one_string() {
    assert_eq!(
        resolve_tokens(&json!("{{testRunId}}-{{index}}"), "run", 7).unwrap(),
        json!("run-7")
    );
}

#[test]
fn unknown_token_raises() {
    let err = resolve_tokens(&json!({"x": "hello-{{mystery}}"}), "r", 0).unwrap_err();
    assert_eq!(err.code, "UNRESOLVED_TOKEN");
    assert!(err.message.contains("mystery"), "message was: {}", err.message);
}

#[test]
fn non_string_primitives_pass_through() {
    assert_eq!(resolve_tokens(&json!(42), "r", 0).unwrap(), json!(42));
    assert_eq!(resolve_tokens(&json!(true), "r", 0).unwrap(), json!(true));
    assert_eq!(resolve_tokens(&Value::Null, "r", 0).unwrap(), Value::Null);
}

#[test]
fn string_without_tokens_unchanged() {
    assert_eq!(resolve_tokens(&json!("plain string"), "r", 0).unwrap(), json!("plain string"));
}
