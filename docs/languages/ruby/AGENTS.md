<!-- BEGIN:autonoma-agent-rules -->

# Autonoma SDK: read the bundled docs before wiring the endpoint

This gem implements the **Autonoma Environment Factory** - a backend endpoint that creates and tears down isolated test data. If you are integrating it, the accurate, version-matched docs ship inside this gem. Read them before writing code; your training data may describe an older, adapter-based API that no longer exists.

**Start here:** `docs/implement.md`, bundled in the `autonoma-ai` gem under its `docs/` directory. Find the installed path with `bundle show autonoma-ai` (then look in `docs/`) or `gem contents autonoma-ai`.

Reading order:

1. `docs/overview.md` - what the Environment Factory is and why it is factory-driven.
2. `docs/implement.md` - step-by-step setup: install, factories, handler, auth, validate.
3. `docs/factories.md` - the `Autonoma::Factory.define_factory` contract in Ruby.
4. `docs/scenarios.md` - the `create` data format (`_alias`/`_ref`).
5. `docs/protocol.md` - the HTTP wire protocol and error codes.
6. `docs/validation.md` - dry-running scenarios by driving `Autonoma::Handler.handle_request`.

Key facts that differ from older docs: the gem is `autonoma-ai` and the SDK is **factory-driven** (register factories with `Autonoma::Factory.define_factory`; there is no ActiveRecord/ORM adapter and no SQL fallback). The core entry point is `Autonoma::Handler.handle_request(config, req)`, wrapped for Rails by `AutonomaRails::Handler#autonoma_handle(config)` (a controller mixin) or `AutonomaRails::Middleware` (Rack). Configuration is an `Autonoma::HandlerConfig` struct with keys `scope_field`, `shared_secret`, `signing_secret`, `factories`, `allow_production`, and `auth`. A factory's `create` returns a hash with a string `"id"` key; a factory declares its fields via `input_fields:` (an array of `{ name:, type:, required: }` hashes), not a schema library. The `auth` callback returns `{ "cookies" => [...], "headers" => {...}, "credentials" => {...} }` - there is no `"token"` field, and the endpoint gate is `allow_production` (not any environment variable).

<!-- END:autonoma-agent-rules -->
