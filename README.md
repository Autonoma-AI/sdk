# Autonoma SDK

Multi-language SDK for the Autonoma Environment Factory endpoint. Define typed factories per model, and the SDK handles HMAC authentication, dependency-ordered entity creation via `_alias`/`_ref` graphs, and scoped teardown.

## Language SDKs

| Language | Path | Server Adapters |
|----------|------|-----------------|
| TypeScript | [`sdks/typescript/`](sdks/typescript/) | Express, Web (Next/Hono/Deno), Node HTTP |
| Python | [`sdks/python/`](sdks/python/) | FastAPI, Flask, Django |
| Elixir | [`sdks/elixir/`](sdks/elixir/) | Plug (Phoenix) |
| Java | [`sdks/java/`](sdks/java/) | Spring Boot (Spring MVC) |
| Ruby | [`sdks/ruby/`](sdks/ruby/) | Rails |
| Rust | [`sdks/rust/`](sdks/rust/) | Actix Web, Axum |
| Go | [`sdks/go/`](sdks/go/) | Gin |
| PHP | [`sdks/php/`](sdks/php/) | Laravel |

## Architecture

All SDKs implement the same protocol with identical core modules:

- **handler** -- request routing (discover/up/down), HMAC verification, environment gating, error wrapping
- **hmac** -- HMAC-SHA256 signing/verification for request authentication
- **refs** -- JWT-like token (header.payload.signature) for signing/verifying created entity refs
- **graph** -- topological sort + cycle detection for dependency ordering
- **schema** -- builds the discover response from registered factory input definitions (Zod, Pydantic, struct tags, etc.)
- **fingerprint** -- deterministic SHA-256 hash of scenario definitions

Every response includes protocol version and SDK metadata:

```json
{
  "version": "1.0",
  "sdk": { "language": "typescript", "server": "express" }
}
```

## Shared Test Infrastructure

- **`conformance/`** -- Language-agnostic JSON fixtures that verify core algorithm behavior (graph sorting, HMAC, refs, fingerprinting) across all implementations
- **`protocol/`** -- HTTP-level test suites that validate the full request/response cycle against any running SDK server
- **`examples/`** -- Runnable example projects for every supported language ([see examples README](examples/README.md))

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
