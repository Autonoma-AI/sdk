# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Autonoma SDK — a TypeScript SDK that automates the Autonoma Environment Factory endpoint. Customers install `@autonoma/sdk` + an ORM adapter (`@autonoma/sdk-prisma` or `@autonoma/sdk-drizzle`) + a server adapter (`@autonoma/server-web`, `server-express`, or `server-node`) to get a working factory endpoint in ~15 lines. The SDK handles HMAC verification, JWT refs, template resolution, FK-ordered entity creation, and scoped teardown.

## Commands

```bash
pnpm install              # install all workspace deps
pnpm build                # turbo build all packages (tsup)
pnpm test                 # turbo test (builds first, then runs vitest)
npx vitest run            # run all tests directly (faster, no build step)
npx vitest run packages/sdk/test/handler.test.ts  # run a single test file
npx vitest run -t "HMAC"  # run tests matching a name pattern
```

CLI tools:
```bash
npx autonoma validate <schema.json> <scenario.json>        # validate scenario against schema (exit 0/1, JSON output with fix suggestions)
npx autonoma schema convert <dmmf.json> --scope-field <f>  # convert Prisma DMMF to autonoma-schema.json
```

Protocol test runner (against a running server):
```bash
npx tsx tests/protocol/test-runner.ts --url http://localhost:3000/api/autonoma --secret <secret>
```

## Architecture

### Package Dependency Graph

```
@autonoma/server-web ──┐
@autonoma/server-express ─┤
@autonoma/server-node ────┤──► @autonoma/sdk (core protocol)
@autonoma/sdk-prisma ─────┤
@autonoma/sdk-drizzle ────┘
```

All packages depend on `@autonoma/sdk`. No package depends on another adapter or server package.

### Core Split: SDK vs Adapters vs Servers

**`@autonoma/sdk`** owns protocol logic that is ORM- and framework-agnostic:
- `handler.ts` — request routing (`discover`/`up`/`down` actions), environment gating, error wrapping
- `hmac.ts` — HMAC-SHA256 signing/verification for request authentication
- `refs.ts` — JWT-like token (header.payload.signature) for signing/verifying created entity refs
- `template.ts` — resolves `{{testRunId}}`, `{{refs.model[i].field}}`, `{{cycle(...)}}`, etc. in entity specs
- `graph.ts` — Kahn's topo sort + Tarjan's SCC for FK ordering and cycle detection (exported at `@autonoma/sdk/graph` for adapter reuse)
- `validate.ts` — static validation of scenario specs against schema (model names, fields, refs, FKs)
- `check.ts` — `checkScenario()` dry-run: full up→down against real DB, catches unique constraints, enum errors, type mismatches
- `tree.ts` — nested scenario format resolver (tree → flat entities with auto-wired FKs)
- `cli.ts` — `autonoma` CLI binary: `validate` and `schema convert`
- `fingerprint.ts` — deterministic sha256-based hash of scenario definitions

**ORM adapters** (`sdk-prisma`, `sdk-drizzle`) implement the `OrmAdapter` interface (defined in `@autonoma/sdk/types.ts`):
- `getSchema()` — introspect ORM metadata into `SchemaInfo` (models, FK edges, scope field)
- `createEntities()` — actual DB writes
- `teardown()` — scoped deletion in reverse topo order

**Server adapters** (`server-web`, `server-express`, `server-node`) convert between framework-specific request/response types and the internal `HandlerRequest`/`HandlerResponse` used by `handler.ts`. Each is ~15 lines.

### Request Flow

1. Server adapter receives HTTP POST, extracts raw body + headers → `HandlerRequest`
2. `handler.ts`: verify HMAC → parse JSON → switch on `action`
3. **discover**: build environment descriptors from scenario definitions + schema
4. **up**: topo-sort entities by FK graph → resolve templates per-entity → call `adapter.createEntities()` → sign refs into JWT token
5. **down**: verify refs JWT → call `adapter.teardown(testRunId)`

### Circular FK Handling

Graph algorithms detect cycles via Kahn's algorithm (remaining nodes) + Tarjan's SCC. Resolution: find a nullable FK in the cycle, create that entity with FK=null, create the partner, then backfill via UPDATE.

## Key Conventions

- All packages are ESM-only (`"type": "module"` in package.json)
- `verbatimModuleSyntax` is enabled — use `import type` for type-only imports
- **Never use `.js` extensions in imports** — write `from './handler'`, not `from './handler.js'`. tsup handles resolution.
- Tests live in `packages/<name>/test/` and use vitest
- Root `vitest.config.ts` has aliases so tests can `import from '@autonoma/sdk'` without building first
- tsup handles bundling; each package has its own `tsup.config.ts`
- Fixtures (DMMF mock, sample scenarios) live in `fixtures/` at repo root
- Integration tests use testcontainers (Postgres) and live in `tests/integration/`
- Protocol test suites are declarative JSON files in `tests/protocol/suites/`
- Full architecture guide at `docs/architecture.md`, LLM skill doc at `docs/skill-scenario-generation.md`
