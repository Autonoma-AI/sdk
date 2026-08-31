//! Autonoma SDK for Rust (Scenario v2).
//!
//! A host app registers named scenarios; the platform calls discover/up/down
//! over an HMAC-signed HTTP request and the SDK owns the envelope: refs-token
//! signing, expiry defaults, and the protocol version field. Scenarios are the
//! [`scenario::Scenario`] trait; a scenario's `up` runs free-form async code
//! and returns the `auth`/`teardown` a test run needs.
//!
//! # Features
//!
//! - `actix` — Actix Web server adapter
//! - `axum` — Axum server adapter

pub mod actix;
pub mod axum;
pub mod errors;
pub mod factory;
pub mod handler;
pub mod hmac;
pub mod refs;
pub mod scenario;
pub mod types;
pub mod unique;
