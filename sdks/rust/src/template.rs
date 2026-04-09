//! Template expression resolution for {{...}} expressions in entity specs.

use chrono::{Duration, Utc};
use rand::Rng;
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

static TEMPLATE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{\{(.+?)\}\}").unwrap());
static FULL_TEMPLATE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\{\{(.+?)\}\}$").unwrap());
static CYCLE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^cycle\(\[(.+)\]\)$").unwrap());
static PICK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^pick\(\[(.+)\]\)$").unwrap());
static RAND_INT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^random\.int\((\d+),\s*(\d+)\)$").unwrap());
static RAND_FLOAT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^random\.float\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\)$").unwrap());
static DAYS_AGO_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^daysAgo\((\d+)\)$").unwrap());

/// Resolve all {{...}} expressions in a value. Handles strings, dicts, lists recursively.
pub fn resolve_template(value: &Value, ctx: &Value) -> Value {
    match value {
        Value::String(s) => resolve_string(s, ctx),
        Value::Array(arr) => Value::Array(arr.iter().map(|v| resolve_template(v, ctx)).collect()),
        Value::Object(map) => {
            let resolved: serde_json::Map<String, Value> = map
                .iter()
                .map(|(k, v)| (k.clone(), resolve_template(v, ctx)))
                .collect();
            Value::Object(resolved)
        }
        other => other.clone(),
    }
}

fn resolve_string(s: &str, ctx: &Value) -> Value {
    // If the entire string is a single expression, return raw value (preserving type)
    if let Some(caps) = FULL_TEMPLATE_RE.captures(s) {
        let expr = caps.get(1).unwrap().as_str().trim();
        return evaluate_expression(expr, ctx);
    }

    // Otherwise, interpolate expressions into the string
    let result = TEMPLATE_RE.replace_all(s, |caps: &regex::Captures| {
        let expr = caps.get(1).unwrap().as_str().trim();
        let val = evaluate_expression(expr, ctx);
        match val {
            Value::String(s) => s,
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            Value::Null => "null".to_string(),
            other => other.to_string(),
        }
    });
    Value::String(result.into_owned())
}

fn evaluate_expression(expr: &str, ctx: &Value) -> Value {
    if expr == "testRunId" {
        let val = ctx
            .get("testRunId")
            .or_else(|| ctx.get("test_run_id"))
            .cloned()
            .unwrap_or(Value::String(String::new()));
        return val;
    }

    if expr == "index" {
        let idx = ctx
            .get("index")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        return Value::Number(idx.into());
    }

    if expr == "index1" {
        let idx = ctx
            .get("index")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        return Value::Number((idx + 1).into());
    }

    if expr == "now()" {
        let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        return Value::String(now);
    }

    // cycle([...])
    if let Some(caps) = CYCLE_RE.captures(expr) {
        let items = parse_array_literal(caps.get(1).unwrap().as_str());
        let index = ctx
            .get("index")
            .and_then(|v| v.as_i64())
            .unwrap_or(0) as usize;
        let picked = &items[index % items.len()];
        return Value::String(picked.clone());
    }

    // pick([...])
    if let Some(caps) = PICK_RE.captures(expr) {
        let items = parse_array_literal(caps.get(1).unwrap().as_str());
        let mut rng = rand::thread_rng();
        let idx = rng.gen_range(0..items.len());
        return Value::String(items[idx].clone());
    }

    // random.int(a,b)
    if let Some(caps) = RAND_INT_RE.captures(expr) {
        let min: i64 = caps.get(1).unwrap().as_str().parse().unwrap();
        let max: i64 = caps.get(2).unwrap().as_str().parse().unwrap();
        let mut rng = rand::thread_rng();
        let val = rng.gen_range(min..=max);
        return Value::Number(val.into());
    }

    // random.float(a,b)
    if let Some(caps) = RAND_FLOAT_RE.captures(expr) {
        let min: f64 = caps.get(1).unwrap().as_str().parse().unwrap();
        let max: f64 = caps.get(2).unwrap().as_str().parse().unwrap();
        let mut rng = rand::thread_rng();
        let val = rng.gen_range(min..max);
        return serde_json::Number::from_f64(val)
            .map(Value::Number)
            .unwrap_or(Value::Null);
    }

    // daysAgo(n)
    if let Some(caps) = DAYS_AGO_RE.captures(expr) {
        let n: i64 = caps.get(1).unwrap().as_str().parse().unwrap();
        let dt = Utc::now() - Duration::days(n);
        let iso = dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        return Value::String(iso);
    }

    Value::String(format!("Template error: unknown expression '{}'", expr))
}

fn parse_array_literal(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| {
            let s = s.trim();
            if (s.starts_with('\'') && s.ends_with('\''))
                || (s.starts_with('"') && s.ends_with('"'))
            {
                s[1..s.len() - 1].to_string()
            } else {
                s.to_string()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolves_test_run_id() {
        let result = resolve_template(
            &json!("{{testRunId}}"),
            &json!({"testRunId": "run-123"}),
        );
        assert_eq!(result, json!("run-123"));
    }

    #[test]
    fn resolves_index() {
        let result = resolve_template(&json!("{{index}}"), &json!({"index": 2}));
        assert_eq!(result, json!(2));
    }

    #[test]
    fn resolves_cycle() {
        let result = resolve_template(
            &json!("{{cycle(['a','b','c'])}}"),
            &json!({"index": 4}),
        );
        assert_eq!(result, json!("b"));
    }

    #[test]
    fn preserves_non_string_types() {
        let result = resolve_template(&json!(42), &json!({}));
        assert_eq!(result, json!(42));
    }

    #[test]
    fn string_interpolation() {
        let result = resolve_template(
            &json!("hello-{{testRunId}}-world"),
            &json!({"testRunId": "abc"}),
        );
        assert_eq!(result, json!("hello-abc-world"));
    }
}
