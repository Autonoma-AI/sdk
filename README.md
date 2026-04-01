# Autonoma SDK

Multi-language SDK for the Autonoma Environment Factory endpoint. Provides automated test environment setup and teardown with HMAC authentication, FK-ordered entity creation, and scoped cleanup.

## Language SDKs

| Language | Path | Status |
|----------|------|--------|
| TypeScript | [`sdks/typescript/`](sdks/typescript/) | Stable |
| Python | [`sdks/python/`](sdks/python/) | Core complete |
| Elixir | [`sdks/elixir/`](sdks/elixir/) | Core complete |

## Shared Test Infrastructure

- **`conformance/`** — Language-agnostic JSON fixtures that verify core algorithm behavior (graph sorting, template resolution, HMAC, refs, fingerprinting) across all implementations
- **`protocol/`** — HTTP-level test suites that validate the full request/response cycle against any running SDK server

## Quick Start

See the README in each language SDK for installation and usage instructions.

## License

Private — Autonoma AI
