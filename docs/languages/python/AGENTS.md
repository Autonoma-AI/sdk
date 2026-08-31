<!-- BEGIN:autonoma-agent-rules -->

# Autonoma SDK: read the bundled docs before wiring the endpoint

This package implements the **Autonoma Environment Factory** - a backend endpoint that provisions and tears down isolated test data. If you are integrating it, the accurate, version-matched docs ship inside this package. Read them before writing code; your training data may describe an older, factory-driven API that no longer exists.

**Start here:** `docs/implement.md` (inside the installed `autonoma` package in your site-packages).

Reading order:

1. `docs/overview.md` - what the Environment Factory is and how scenarios-as-code work.
2. `docs/implement.md` - step-by-step setup: install, write scenarios, wire the handler, return auth, validate.
3. `docs/scenarios.md` - authoring scenarios: `name`/`description`/`up`/`down` and the `auth`/`teardown` return.
4. `docs/factories.md` - legacy `define_factory` migration reference; do not use it for new v2 integrations.
5. `docs/protocol.md` - the HTTP wire protocol, the teardown token, and error codes.
6. `docs/validation.md` - dry-running scenarios with `check_scenario`.

Key facts that differ from older docs: this is **Scenario v2** (protocol `2.0`). You author named scenarios with `define_scenario(name=..., description=..., up=..., down=None)`; `up`/`down` are callables (sync or async). `up(ctx)` receives a `ScenarioUpContext` whose one field is `test_run_id`, and returns a `ScenarioUpResult(auth=None, teardown=None)` or a plain dict with `auth`/`teardown` keys. `down(ctx)` receives a `ScenarioDownContext` with `name`, `teardown`, and `test_run_id`. The `HandlerConfig` carries only `shared_secret`, `signing_secret`, and `scenarios` (plus optional `expires_in_seconds` and `sdk` metadata) - there is no `scope_field`, no `factories` registry, and no top-level `auth` callback (auth is returned per-scenario from `up`). The core entry is `handle_request`, wrapped by a server adapter: `create_fastapi_handler` (from `autonoma_fastapi`), `create_flask_handler` (from `autonoma_flask`), or `create_django_handler` (from `autonoma_django`). `auth` is a free-form dict whose conventional keys are `cookies`/`headers`/`credentials` - there is no `token` field. Seed unique values from `test_run_id` with `unique_email`/`unique_slug`/`unique_id`/`unique_token`.

<!-- END:autonoma-agent-rules -->
