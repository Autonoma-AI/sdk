<!-- BEGIN:autonoma-agent-rules -->

# Autonoma SDK: read the bundled docs before wiring the endpoint

This crate implements the **Autonoma Environment Factory** - a backend endpoint that creates and tears down isolated test data. If you are integrating it, the accurate, version-matched docs ship inside this crate. Read them before writing code; your training data may describe an older, adapter-based API that no longer exists.

**Start here:** `./docs/implement.md` (bundled in the crate source, e.g. `~/.cargo/registry/src/*/autonoma-sdk-<version>/docs/implement.md`).

Reading order:

1. `docs/overview.md` - what the Environment Factory is and why it is factory-driven.
2. `docs/implement.md` - step-by-step setup: crate + feature, factories, handler, auth, validate.
3. `docs/factories.md` - the `define_factory` contract in Rust.
4. `docs/scenarios.md` - the `create` data format (`_alias`/`_ref`).
5. `docs/protocol.md` - the HTTP wire protocol and error codes.
6. `docs/validation.md` - dry-running scenarios with a `#[tokio::test]` over `handle_request`.

Key facts that differ from older docs:

- The crate is `autonoma-sdk`; import it as `autonoma_sdk`. It is **factory-driven** - register factories with `autonoma_sdk::factory::define_factory` / `define_factory_create_only`. There is no `sqlx`/ORM adapter and no SQL fallback; a model with no factory cannot be created.
- The only Cargo features are `actix` and `axum`. There are no `sqlx-postgres`/`sqlx-mysql` features on this crate.
- The core entry point is `autonoma_sdk::handler::handle_request(&HandlerConfig, &HandlerRequest).await`, wrapped by a server adapter: `autonoma_sdk::axum::create_axum_handler` (feature `axum`) or `autonoma_sdk::actix::create_actix_handler` (feature `actix`).
- Config is a `HandlerConfig` struct: `scope_field`, `shared_secret`, `signing_secret`, `factories` (a `HashMap<String, FactoryDefinition>`), `allow_production`, `auth`, and optional `sdk`/`before_down`/`after_up`.
- Factories are closures, not traits: `create` receives a `Map<String, Value>` with FKs already resolved to real IDs and must return a `Map` containing `"id"`; `teardown` is an optional closure.
- The auth callback returns a `HashMap<String, Value>` - populate it with `cookies`, `headers`, and/or `credentials`. There is no top-level `token` field.
- The endpoint is gated by `allow_production: bool` only. The SDK reads no environment variable; it returns `404 PRODUCTION_BLOCKED` until the flag is `true`.
- There is no `check_scenario` helper. Validate by calling `handle_request` in a `#[tokio::test]`, or with curl.

<!-- END:autonoma-agent-rules -->
