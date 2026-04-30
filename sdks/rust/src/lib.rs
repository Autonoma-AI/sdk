//! Autonoma SDK for Rust.
//!
//! Factory-driven design: every model is owned by a registered factory whose
//! input is described by `Vec<FieldDef>`. There is no SQL introspection — the
//! SDK derives discover schema from factory input_fields and uses the create
//! payload's `_alias`/`_ref` graph for ordering.
//!
//! # Features
//!
//! - `actix` — Actix Web server adapter
//! - `axum` — Axum server adapter

pub mod actix;
pub mod axum;
pub mod errors;
pub mod factory;
pub mod fingerprint;
pub mod graph;
pub mod handler;
pub mod hmac;
pub mod payload_topo;
pub mod refs;
pub mod schema;
pub mod types;
