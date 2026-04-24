# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Autonoma SDK — a multi-language SDK that automates the Autonoma Environment Factory endpoint. Each language implementation lives under `sdks/<language>/` and must pass the shared conformance test suite. The SDK handles HMAC verification, JWT refs, FK-ordered entity creation, and scoped teardown.

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
    rust/               # Rust SDK (Cargo, features: actix, sqlx-postgres)
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
poetry run pytest tests/test_sqlalchemy_adapter.py  # single test file
poetry run pytest -k "sqlalchemy"                   # tests matching pattern
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
ruby -Ilib -Itest test/test_hmac.rb test/test_refs.rb test/test_fingerprint.rb test/test_graph.rb test/test_handler.rb test/test_create.rb
```

### Rust
```bash
cd sdks/rust
cargo build && cargo test                     # full build + test
cargo test -- hmac                            # tests matching a name pattern
cargo build --features actix                  # build with Actix Web adapter
cargo build --features axum                   # build with Axum adapter
cargo build --features sqlx-postgres          # build with SQLx Postgres adapter
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

- **handler** — request routing (discover/up/down), HMAC verification, environment gating, error wrapping
- **hmac** — HMAC-SHA256 signing/verification for request authentication
- **refs** — JWT-like token (header.payload.signature) for signing/verifying created entity refs
- **graph** — Kahn's topo sort + Tarjan's SCC for FK ordering and cycle detection
- **fingerprint** — deterministic sha256-based hash of scenario definitions
- **factory** — optional user-defined entity factories (`defineFactory`) for models with business logic; SDK falls back to raw SQL for models without factories (hybrid mode)
- **ORM adapter** — implements getSchema(), createEntities(), teardown() for a specific ORM
- **Server adapter** — converts framework-specific request/response to internal types

### Entity Factories (Hybrid Mode)

The SDK supports a **hybrid** approach to entity creation. Users can register factories for models that have business logic (password hashing, external service calls, state machines, etc.) while letting the SDK handle simpler models via raw SQL.

**Key types** (reference implementation in TypeScript):
- `FactoryDefinition` — `{ create(data, ctx), teardown?(record, ctx) }`. `create` receives pre-resolved fields (temp IDs already replaced with real FK IDs). Must return at least the PK field.
- `FactoryContext` — `{ refs, executor, scenarioName, testRunId }`. Passed to both `create` and `teardown`.
- `FactoryRegistry` — `Record<string, FactoryDefinition>`. Passed as `factories` on `HandlerConfig`.

**How it works:**
1. Tree resolution and topological sorting happen as before
2. For each model in topo order: if a factory is registered, call `factory.create()` per record; otherwise use raw SQL INSERT
3. FK fields are pre-resolved before reaching the factory (Option A — factories never see `__temp_*` IDs)
4. On teardown: if a factory defines `teardown`, call it per record in reverse order; otherwise fall back to SQL DELETE
5. Deferred updates (circular FK cycles) always use raw SQL `updateEntity`

**Factory return contract:** Must return at least `{ id }` (or whatever the PK field is named). All returned fields are stored in refs and passed to the test runner. Fields don't need to match DB column names — only the PK matters for FK wiring.

**Language-native patterns:**
- TypeScript/Python/Ruby: closures/lambdas
- Java: interfaces (`FactoryDefinition`)
- Go: struct with function fields
- Rust: traits with `async_trait`
- Elixir: 2-arity functions
- PHP: callables

**Troubleshooting factory errors:**

| Error Code | Cause | Fix |
|------------|-------|-----|
| `FACTORY_MISSING_PK` | Factory `create` returned a record without the primary key field | Ensure your factory returns at least `{ id: "..." }` (or whatever the PK is named in the schema). The SDK needs the PK to wire FK references between models. |
| `SAME_SECRETS` | `sharedSecret` and `signingSecret` are identical | Use two distinct secrets — the shared secret authenticates requests, the signing secret signs refs tokens. Reusing one for both is a security risk. |
| `INVALID_SIGNATURE` | HMAC verification failed on the incoming request | Check that the `sharedSecret` in your SDK config matches the one configured in the Autonoma dashboard. |
| `INVALID_REFS_TOKEN` | The `refsToken` in a `down` request could not be verified | The token was signed with a different `signingSecret` or was tampered with. Ensure the same config is used for `up` and `down`. |
| `UNKNOWN_ACTION` | Request body has an unrecognized `action` value | Valid actions are `discover`, `up`, and `down`. |
| `INVALID_BODY` | Request body is not valid JSON or is missing required fields | Check that the request body is valid JSON and includes `action`. For `up`, include `create`; for `down`, include `refsToken`. |
| `PRODUCTION_BLOCKED` | SDK detected a production environment | Set `allowProduction: true` in config, set `AUTONOMA_ENABLED=1` in the process environment to override at deploy time (accepts `1`/`true`/`yes`, case-insensitive), or ensure `NODE_ENV`/`PYTHON_ENV`/`ENV` is not set to `"production"`. |

### Available Adapters

| Language | ORM Adapters | Server Adapters |
|----------|-------------|-----------------|
| TypeScript | Prisma, Drizzle | Express, Web (Next/Hono/Deno), Node HTTP |
| Python | SQLAlchemy, Django | FastAPI, Flask, Django |
| Elixir | Ecto | Plug (Phoenix) |
| PHP | Eloquent (raw SQL) | Laravel |
| Java | JDBC | Spring Boot (Spring MVC) |
| Ruby | ActiveRecord | Rails |
| Rust | SQLx | Actix Web, Axum |
| Go | database/sql | Gin |

### Protocol Versioning

Every response (discover/up/down) includes:
```json
{
  "version": "1.0",
  "sdk": { "language": "typescript", "orm": "prisma", "server": "express" }
}
```

## Multi-Language Rules

This SDK exists in eight languages: **TypeScript**, **Python**, **Elixir**, **PHP**, **Java**, **Ruby**, **Rust**, and **Go**. They are independent implementations that must behave identically, verified by the shared conformance suite.

### Adding features or fixing bugs

- Any change to protocol behavior (handler, HMAC, refs, graph, fingerprint) **must be implemented in all eight languages**.
- Add or update conformance test cases in `conformance/` to cover the new behavior, then verify all eight pass: `cd conformance && npx tsx run.ts`.
- Run each language's own unit tests after changes.

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
- Python: src layout, Poetry (pyproject.toml), extras for adapters (`autonoma-sdk[sqlalchemy]`, `autonoma-sdk[fastapi]`, etc.)
- PHP: PSR-4 autoloading, Composer (composer.json), Laravel service provider auto-discovery
- Java: Maven multi-module, Java 17+, records for data types, Spring Boot 3.x for server adapter
- Ruby: gemspec with no hard runtime dependencies (stdlib only), ActiveRecord/Rails as optional adapters
- Rust: Cargo crate with optional feature flags (`actix`, `axum`, `sqlx-postgres`, `sqlx-mysql`), async-trait for executor abstraction
- Go: standard Go module, `database/sql` executor adapter, Gin server adapter
- All SDKs must pass `conformance/` fixtures and `protocol/` test suites
- Protocol responses include `version` and `sdk` metadata for traceability
