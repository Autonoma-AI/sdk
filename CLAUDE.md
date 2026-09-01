# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Autonoma SDK — a multi-language SDK that implements the Autonoma Environment Factory endpoint. A customer authors named **scenarios** in their own code with `defineScenario` (or the language's equivalent). Each scenario's `up` runs free-form code that provisions an isolated environment and returns `{ auth?, teardown? }`; its optional `down` tears that environment back down. The SDK owns only the envelope: HMAC request verification, the signed teardown token, expiry, and the protocol version. Each language implementation lives under `sdks/<language>/` and must behave identically, verified by the shared conformance suite.

This is **Scenario v2** (protocol `2.0`). The v1 factory-driven model - a declarative `create` graph with `_alias`/`_ref` edges, topological sorting, and a required factory per model - is gone from the wire. `defineFactory` survives only as an optional helper a scenario's `up`/`down` may call internally.

## Repository Structure

```
root/
  conformance/          # Language-agnostic JSON test fixtures + runner
  protocol/             # HTTP-level protocol test suites (shared across languages)
  sdks/
    typescript/         # TypeScript SDK (pnpm/turbo monorepo)
    elixir/             # Elixir SDK (mix project)
    python/             # Python SDK (pyproject.toml)
    php/                # PHP/Laravel SDK (composer)
    java/               # Java SDK (Maven multi-module)
    ruby/               # Ruby SDK (gemspec)
    rust/               # Rust SDK (Cargo, features: actix, axum)
    go/                 # Go SDK (go module)
```

## Commands

### TypeScript
```bash
cd sdks/typescript
pnpm install && pnpm build && pnpm test    # full build + test
npx vitest run                              # run tests directly (faster)
npx vitest run packages/sdk/test/handler.test.ts  # single test file
npx vitest run -t "HMAC"                    # tests matching a name pattern
```

### Elixir
```bash
cd sdks/elixir
mix deps.get && mix test
```

### Python
```bash
cd sdks/python
poetry install --all-extras && poetry run pytest   # full install + test
poetry run pytest tests/test_fastapi_adapter.py    # single test file
poetry run pytest -k "fastapi"                      # tests matching pattern
```

### PHP/Laravel
```bash
cd sdks/php
composer install && ./vendor/bin/phpunit         # full install + test
./vendor/bin/phpunit tests/HmacTest.php          # single test file
./vendor/bin/phpunit --filter "HMAC"             # tests matching a name pattern
```

### Java
```bash
cd sdks/java
mvn compile                               # compile all modules
mvn test                                   # run all tests
mvn test -pl autonoma-sdk                  # test only core SDK
mvn package -DskipTests                    # build JARs (including conformance bridge)
```

### Ruby
```bash
cd sdks/ruby
rake test                                                  # all tests (globs test/**/test_*.rb)
ruby -Ilib -Itest test/test_handler.rb                     # single file
```

### Rust
```bash
cd sdks/rust
cargo build && cargo test                     # full build + test
cargo test -- hmac                            # tests matching a name pattern
cargo build --features actix                  # build with Actix Web adapter
cargo build --features axum                   # build with Axum adapter
```

### Go
```bash
cd sdks/go
go test ./autonoma/ -v               # run all tests
go test ./autonoma/ -run TestSignBody # single test
go build ./autonoma/                  # build check
```

### Conformance (all languages)
```bash
cd conformance && npx tsx run.ts
```

### Protocol tests (against a running server)
```bash
npx tsx protocol/test-runner.ts --url http://localhost:3000/api/autonoma --secret <secret>
```

## Architecture

All language SDKs implement the same protocol with the same core modules:

- **handler** — request routing (discover/up/down), HMAC verification, scenario lookup by name, teardown-token signing on `up` and verification on `down`, error wrapping
- **hmac** — HMAC-SHA256 signing/verification for request authentication
- **refs** — JWT-like token (header.payload.signature) that signs and verifies the **teardown token** carrying the scenario name + the scenario's `teardown` handle
- **scenario** — `defineScenario`: validates a scenario definition (`name`/`description`/`up`/`down`) and returns it unchanged
- **unique** — deterministic uniqueness helpers seeded from `testRunId` (`uniqueEmail`, `uniqueSlug`, `uniqueId`, `uniqueToken`)
- **factory** (optional) — `defineFactory` plus the payload-topo helpers. A helper library a scenario's `up`/`down` may call internally; **not wired to the wire protocol** in v2
- **Server adapter** — converts framework-specific request/response to internal types

### Scenarios

The primary surface is `defineScenario`. A scenario has a `name`, a `description`, an `up`, and an optional `down`.

- `up(ctx)` receives `{ testRunId }` and runs free-form async code - loops, conditionals, real API calls, calls into the app's own service layer. It returns up to two optional things:
  - `auth` - credentials the test runner uses to act as the seeded user (`cookies`/`headers`/`credentials`). Secrets live here.
  - `teardown` - any JSON handle `down` needs. Signed into the teardown token, handed back to `down` verbatim, never returned in the clear.
- `down(ctx)` receives `{ name, teardown, testRunId }` recovered from the verified teardown token, and undoes what `up` created. Omitting `down` is a no-op.

There is no `scopeField`, no `factories` registry, and no top-level `auth` callback on the handler config - the config carries only `sharedSecret`, `signingSecret`, `scenarios`, optional `expiresInSeconds`, and optional `sdk` metadata. Auth is returned per-scenario from `up`.

**Uniqueness:** when `up` provisions records with unique columns, seed those values from `testRunId` so they are unique per run yet reproducible. The `unique*` helpers derive unique-yet-deterministic values from `testRunId`, so `up` and a later `down` can recompute the same value without storing it. The digest (`sha256(testRunId + " " + parts...)`, truncated to 12 hex chars) is byte-for-byte identical across all eight languages.

**Language-native authoring patterns:**
- TypeScript / Python: object / dataclass passed to `defineScenario` (`up`/`down` are closures)
- Ruby / PHP / Elixir: a builder (`Scenario.define_scenario` / `Scenario::defineScenario` / `Autonoma.Scenario.define_scenario`) with closure `up`/`down`
- Go: a `ScenarioDefinition` struct with `Up`/`Down` function fields
- Rust: a `Scenario` trait (`#[async_trait]`) or the `define_scenario` closure helper
- Java: `Scenario.define(...)` returning a `ScenarioDefinition` interface (functional `UpFn`/`DownFn`)

**Error codes** (returned as `{ error, code }` with an HTTP status; see `docs/shared/protocol.md`):

| Error Code | HTTP | Cause / Fix |
|------------|------|-------------|
| `SAME_SECRETS` | 500 | `sharedSecret` and `signingSecret` are identical. Use two distinct secrets - the shared one authenticates requests, the signing one signs the teardown token. |
| `INVALID_SIGNATURE` | 401 | HMAC verification failed. The `sharedSecret` in the SDK config must match the one in the Autonoma dashboard. |
| `INVALID_BODY` | 400 | Body is not valid JSON, missing `action`, missing `scenario.name` on `up`, or missing `teardownToken` on `down`. |
| `UNKNOWN_ACTION` | 400 | `action` is not `discover`, `up`, or `down`. |
| `UNKNOWN_ENVIRONMENT` | 400 | The requested scenario name is not registered. |
| `INVALID_TEARDOWN_TOKEN` | 403 | The teardown token could not be verified - signed with a different `signingSecret` or tampered with. Use the same config for `up` and `down`. |
| `PRODUCTION_BLOCKED` | 404 | Deprecated - never returned. The endpoint is always enabled; HMAC signing is the gate. `allowProduction` is an ignored no-op. On Autonoma previews (`AUTONOMA_PREVIEWKIT` set) no guard is needed; gate manually in your handler to keep the endpoint dark in your own production deployments. |

### Available Adapters

There are no ORM adapters. A scenario's `up`/`down` talk to whatever database client or service layer the host app already has. Only server (HTTP framework) adapters are shipped:

| Language | Server Adapters |
|----------|-----------------|
| TypeScript | Web standard (Next.js App Router / Bun / Deno), Express, Hono, Node HTTP |
| Python | FastAPI, Flask, Django |
| Elixir | Plug (Phoenix) |
| PHP | Laravel |
| Java | Spring Boot (Spring MVC) |
| Ruby | Rails / Rack |
| Rust | Actix Web, Axum |
| Go | Gin |

### Protocol Versioning

Every response (discover/up/down) includes:
```json
{
  "version": "2.0",
  "sdk": { "language": "typescript", "orm": "unknown", "server": "web" }
}
```

The platform detects the protocol per deployment from the `version` field.

## Multi-Language Rules

This SDK exists in eight languages: **TypeScript**, **Python**, **Elixir**, **PHP**, **Java**, **Ruby**, **Rust**, and **Go**. They are independent implementations that must behave identically, verified by the shared conformance suite.

### Adding features or fixing bugs

- Any change to protocol behavior (handler routing, HMAC, the teardown token, the uniqueness helpers) **must be implemented in all eight languages**.
- The conformance suite exercises the version-agnostic primitives - `hmac`, `refs`, and the `unique` helpers: every bridge in `conformance/runner.config.json` overrides `modules` to `["hmac", "refs", "unique"]`. The `unique` cases pin the `sha256(testRunId + " " + parts...)` digest byte-for-byte across all eight languages (a token minted in `up` by one language must recompute identically in a later `down` by another). The `graph`/`fingerprint` fixtures are v1 leftovers and are no longer run by any language. Add or update conformance cases as needed, then verify all eight pass: `cd conformance && npx tsx run.ts`.
- Run each language's own unit tests after changes.

### Bundled agent docs

Each published package ships an agent-facing doc set (read from `node_modules` / site-packages / the JAR, etc.) plus an `AGENTS.md` pointer, so a coding agent implementing the SDK reads the version-matched, scenario-based v2 API instead of stale training data. Single source of truth:

- `docs/shared/{overview,protocol,scenarios}.md` + `docs/shared/llms.txt` — language-agnostic, copied verbatim into every package.
- `docs/languages/<lang>/{implement,factories,validation,AGENTS}.md` — language-specific.

`node scripts/build-sdk-docs.mjs` assembles these into each package's shipped `docs/` (+ `AGENTS.md`); the outputs are committed. **Re-run it after editing any doc source, and update the docs when the public API changes.** The `files`/include entries in each manifest (npm `files`, `pyproject` `include`, `mix.exs` `files`, gemspec `files`, Java Maven resources) already ship these; PHP/Rust/Go ship the whole tree.

### Breaking changes and versioning

- If a change is **backwards-incompatible** (changes request/response format, removes a field, alters signing behavior), bump the version in `protocol/version.txt`. All eight SDKs read from this single file:
  - TypeScript: injected at build time via `define` in `tsup.config.ts` and `vitest.config.ts`
  - Python: read at module load in `handler.py` via `pathlib`
  - Elixir: compiled in via `@external_resource` + `File.read!` in `handler.ex`
  - PHP: read at runtime in `Handler.php` via `file_get_contents`
  - Java: included as a classpath resource via Maven and read in `AutonomaHandler.java`
  - Ruby: read at require time in `handler.rb` via `File.read`
  - Rust: compiled in via `include_str!` in `handler.rs`
  - Go: generated via `go generate` into `protocol_version_gen.go`
- Non-breaking additions (new optional fields) do **not** require a version bump.

## Key Conventions

- TypeScript: ESM-only, `verbatimModuleSyntax`, no `.js` extensions in imports
- Elixir: standard mix project conventions
- Python: src layout, Poetry (pyproject.toml), distribution `autonoma-ai`, extras for server adapters (`autonoma-ai[fastapi]`, `autonoma-ai[flask]`, `autonoma-ai[django]`, `autonoma-ai[all]`)
- PHP: PSR-4 autoloading, Composer (composer.json), Laravel service provider auto-discovery
- Java: Maven multi-module, Java 17+, records for data types, Spring Boot 3.x for server adapter
- Ruby: gemspec with no hard runtime dependencies (stdlib only), ActiveRecord/Rails as optional adapters
- Rust: Cargo crate with optional feature flags (`actix`, `axum`), async-trait for the `Scenario` abstraction
- Go: standard Go module, Gin server adapter; a scenario's `Up`/`Down` use the host app's own DB client
- All SDKs must pass `conformance/` fixtures and `protocol/` test suites
- Protocol responses include `version` and `sdk` metadata for traceability
