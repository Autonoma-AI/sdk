# Autonoma SDK

Multi-language SDK for the Autonoma Environment Factory endpoint. Provides automated test environment setup and teardown with HMAC authentication, FK-ordered entity creation, and scoped cleanup.

## Language SDKs

| Language | Path | ORM Adapters | Server Adapters |
|----------|------|-------------|-----------------|
| TypeScript | [`sdks/typescript/`](sdks/typescript/) | Prisma, Drizzle | Express, Web (Next/Hono/Deno), Node HTTP |
| Python | [`sdks/python/`](sdks/python/) | SQLAlchemy, Django | FastAPI, Flask, Django |
| Elixir | [`sdks/elixir/`](sdks/elixir/) | Ecto | Plug (Phoenix) |
| Java | [`sdks/java/`](sdks/java/) | JDBC | Spring Boot (Spring MVC) |
| Ruby | [`sdks/ruby/`](sdks/ruby/) | ActiveRecord | Rails |

## Architecture

All SDKs implement the same protocol with identical core modules:

- **handler** -- request routing (discover/up/down), HMAC verification, environment gating, error wrapping
- **hmac** -- HMAC-SHA256 signing/verification for request authentication
- **refs** -- JWT-like token (header.payload.signature) for signing/verifying created entity refs
- **graph** -- topological sort + cycle detection for FK ordering
- **fingerprint** -- deterministic SHA-256 hash of scenario definitions

Every response includes protocol version and SDK metadata:

```json
{
  "version": "1.0",
  "sdk": { "language": "typescript", "orm": "prisma", "server": "express" }
}
```

## Shared Test Infrastructure

- **`conformance/`** -- Language-agnostic JSON fixtures that verify core algorithm behavior (graph sorting, HMAC, refs, fingerprinting) across all implementations
- **`protocol/`** -- HTTP-level test suites that validate the full request/response cycle against any running SDK server
- **`examples/`** -- Runnable example projects for TypeScript, Python, and Elixir ([see examples README](examples/README.md))

## Quick Start

See the README in each language SDK for installation and usage instructions.

## Development

```bash
# Run conformance tests across all languages
cd conformance && npx tsx run.ts

# Run protocol tests against a running server
npx tsx protocol/test-runner.ts --url http://localhost:3000/api/autonoma --secret <secret>
```

## License

Private -- Autonoma AI
