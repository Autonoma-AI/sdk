//! Conformance test bridge for the Rust SDK.
//!
//! Reads a JSON test case from stdin, dispatches to the appropriate SDK
//! function, and writes the result to stdout. Scenario-v2 dropped the
//! create-graph interpreter and `fingerprint`; the Rust SDK conforms on the
//! version-agnostic `hmac`, `refs`, and `unique` primitives.

use serde_json::{json, Value};
use std::io::{self, Read};

use autonoma_sdk::hmac::{sign_body, verify_signature};
use autonoma_sdk::refs::{sign_refs, verify_refs, RefsPayload};
use autonoma_sdk::unique::{unique_email, unique_id, unique_slug, unique_token};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();

    let data: Value = serde_json::from_str(&input).unwrap();

    let module = data["module"].as_str().unwrap_or("");
    let function = data["function"].as_str().unwrap_or("");
    let inp = &data["input"];

    match dispatch(module, function, inp) {
        Ok(val) => println!("{}", json!({ "ok": true, "result": val })),
        Err(e) => println!("{}", json!({ "ok": false, "error": e })),
    }
}

fn dispatch(module: &str, function: &str, inp: &Value) -> Result<Value, String> {
    match (module, function) {
        ("hmac", "signBody") => {
            let body = inp["body"].as_str().ok_or("missing body")?;
            let secret = inp["secret"].as_str().ok_or("missing secret")?;
            Ok(Value::String(sign_body(body, secret)))
        }
        ("hmac", "verifySignature") => {
            let body = inp["body"].as_str().ok_or("missing body")?;
            let signature = inp["signature"].as_str().ok_or("missing signature")?;
            let secret = inp["secret"].as_str().ok_or("missing secret")?;
            Ok(Value::Bool(verify_signature(body, signature, secret)))
        }
        ("refs", "signRefs") => {
            let payload: RefsPayload =
                serde_json::from_value(inp["payload"].clone()).map_err(|e| e.to_string())?;
            let secret = inp["secret"].as_str().ok_or("missing secret")?;
            Ok(Value::String(sign_refs(&payload, secret)))
        }
        ("refs", "verifyRefs") => {
            let token = inp["token"].as_str().ok_or("missing token")?;
            let secret = inp["secret"].as_str().ok_or("missing secret")?;
            let payload = verify_refs(token, secret)?;
            Ok(json!({
                "refs": payload.refs,
                "testRunId": payload.test_run_id,
                "environment": payload.environment,
            }))
        }
        ("unique", "uniqueToken") => {
            let test_run_id = inp["testRunId"].as_str().ok_or("missing testRunId")?;
            let parts: Vec<&str> = inp["parts"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            Ok(Value::String(unique_token(test_run_id, &parts)))
        }
        ("unique", "uniqueId") => {
            let test_run_id = inp["testRunId"].as_str().ok_or("missing testRunId")?;
            let prefix = inp["prefix"].as_str().ok_or("missing prefix")?;
            let parts: Vec<&str> = inp["parts"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            Ok(Value::String(unique_id(test_run_id, prefix, &parts)))
        }
        ("unique", "uniqueSlug") => {
            let test_run_id = inp["testRunId"].as_str().ok_or("missing testRunId")?;
            let base = inp["base"].as_str().ok_or("missing base")?;
            let parts: Vec<&str> = inp["parts"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            Ok(Value::String(unique_slug(test_run_id, base, &parts)))
        }
        ("unique", "uniqueEmail") => {
            let test_run_id = inp["testRunId"].as_str().ok_or("missing testRunId")?;
            let local = inp["local"].as_str().ok_or("missing local")?;
            let domain = inp["domain"].as_str().ok_or("missing domain")?;
            Ok(Value::String(unique_email(test_run_id, local, domain)))
        }
        _ => Err(format!("Unknown function: {}.{}", module, function)),
    }
}
