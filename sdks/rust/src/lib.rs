//! Autonoma SDK for Rust.
//!
//! Automates the Autonoma Environment Factory endpoint. Handles HMAC verification,
//! JWT refs, template resolution, FK-ordered entity creation, and scoped teardown.
//!
//! # Features
//!
//! - `actix` — Actix Web server adapter
//! - `sqlx-postgres` — SQLx executor for PostgreSQL
//! - `sqlx-mysql` — SQLx executor for MySQL

pub mod actix;
pub mod create;
pub mod dialect;
pub mod errors;
pub mod fingerprint;
mod generated;
pub mod graph;
pub mod handler;
pub mod hmac;
pub mod introspect;
pub mod refs;
pub mod sqlx_adapter;
pub mod teardown;
pub mod template;
pub mod tree;
pub mod types;
