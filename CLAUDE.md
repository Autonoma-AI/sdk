# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Autonoma SDK — a multi-language SDK that automates the Autonoma Environment Factory endpoint. Each language implementation lives under `sdks/<language>/` and must pass the shared conformance test suite. The SDK handles HMAC verification, JWT refs, template resolution, FK-ordered entity creation, and scoped teardown.

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
- **template** — resolves `{{testRunId}}`, `{{cycle(...)}}`, `{{random.int()}}`, etc.
- **graph** — Kahn's topo sort + Tarjan's SCC for FK ordering and cycle detection
- **fingerprint** — deterministic sha256-based hash of scenario definitions
- **ORM adapter** — implements getSchema(), createEntities(), teardown() for a specific ORM
- **Server adapter** — converts framework-specific request/response to internal types

### Available Adapters

| Language | ORM Adapters | Server Adapters |
|----------|-------------|-----------------|
| TypeScript | Prisma, Drizzle | Express, Web (Next/Hono/Deno), Node HTTP |
| Python | SQLAlchemy, Django | FastAPI, Flask, Django |
| Elixir | Ecto | Plug (Phoenix) |
| PHP | Eloquent (raw SQL) | Laravel |

### Protocol Versioning

Every response (discover/up/down) includes:
```json
{
  "version": "1.0",
  "sdk": { "language": "typescript", "orm": "prisma", "server": "express" }
}
```

## Multi-Language Rules

This SDK exists in four languages: **TypeScript**, **Python**, **Elixir**, and **PHP**. They are independent implementations that must behave identically, verified by the shared conformance suite.

### Adding features or fixing bugs

- Any change to protocol behavior (handler, HMAC, refs, template, graph, fingerprint) **must be implemented in all four languages**.
- Add or update conformance test cases in `conformance/` to cover the new behavior, then verify all three pass: `cd conformance && npx tsx run.ts`.
- Run each language's own unit tests after changes.

### Breaking changes and versioning

- If a change is **backwards-incompatible** (changes request/response format, removes a field, alters signing behavior), bump `PROTOCOL_VERSION` in all four handlers:
  - TypeScript: `sdks/typescript/packages/sdk/src/handler.ts` → `PROTOCOL_VERSION`
  - Python: `sdks/python/src/autonoma/handler.py` → `PROTOCOL_VERSION`
  - Elixir: `sdks/elixir/lib/autonoma/handler.ex` → `@protocol_version`
  - PHP: `sdks/php/src/Handler.php` → `PROTOCOL_VERSION`
- Non-breaking additions (new optional fields, new template expressions) do **not** require a version bump.

## Key Conventions

- TypeScript: ESM-only, `verbatimModuleSyntax`, no `.js` extensions in imports
- Elixir: standard mix project conventions
- Python: src layout, Poetry (pyproject.toml), extras for adapters (`autonoma-sdk[sqlalchemy]`, `autonoma-sdk[fastapi]`, etc.)
- PHP: PSR-4 autoloading, Composer (composer.json), Laravel service provider auto-discovery
- All SDKs must pass `conformance/` fixtures and `protocol/` test suites
- Protocol responses include `version` and `sdk` metadata for traceability
