//! Conformance test bridge for the Rust SDK.
//!
//! Reads a JSON test case from stdin, dispatches to the appropriate SDK function,
//! and writes the result to stdout.

use serde_json::{json, Value};
use std::io::{self, Read};

// We need to import from the library
use autonoma_sdk::fingerprint::fingerprint;
use autonoma_sdk::graph::{find_deferrable_edge, topo_sort};
use autonoma_sdk::hmac::{sign_body, verify_signature};
use autonoma_sdk::refs::{sign_refs, verify_refs};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();

    let data: Value = serde_json::from_str(&input).unwrap();

    let module = data["module"].as_str().unwrap_or("");
    let function = data["function"].as_str().unwrap_or("");
    let inp = &data["input"];

    let result = dispatch(module, function, inp);

    match result {
        Ok(val) => {
            println!("{}", json!({"ok": true, "result": val}));
        }
        Err(e) => {
            println!("{}", json!({"ok": false, "error": e}));
        }
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
            let payload = &inp["payload"];
            let secret = inp["secret"].as_str().ok_or("missing secret")?;
            Ok(Value::String(sign_refs(payload, secret)))
        }
        ("refs", "verifyRefs") => {
            let token = inp["token"].as_str().ok_or("missing token")?;
            let secret = inp["secret"].as_str().ok_or("missing secret")?;
            verify_refs(token, secret).map_err(|e| e)
        }
        ("fingerprint", "fingerprint") => {
            let value = &inp["value"];
            Ok(Value::String(fingerprint(value)))
        }
        ("graph", "topoSort") => {
            let nodes: Vec<String> = inp["nodes"]
                .as_array()
                .ok_or("missing nodes")?
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
            let edges = inp["edges"]
                .as_array()
                .ok_or("missing edges")?
                .to_vec();
            Ok(topo_sort(&nodes, &edges))
        }
        ("graph", "findDeferrableEdge") => {
            let cycle: Vec<String> = inp["cycle"]
                .as_array()
                .ok_or("missing cycle")?
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
            let edges = inp["edges"]
                .as_array()
                .ok_or("missing edges")?
                .to_vec();
            Ok(find_deferrable_edge(&cycle, &edges))
        }
        _ => Err(format!("Unknown function: {}.{}", module, function)),
    }
}
