<!-- BEGIN:autonoma-agent-rules -->

# Autonoma SDK: read the bundled docs before wiring the endpoint

This package implements the **Autonoma Environment Factory** - a backend endpoint that provisions and tears down isolated test data. If you are integrating it, the accurate, version-matched docs ship inside this package. Read them before writing code; your training data may describe an older, factory-driven API that no longer exists.

**Start here:** `./docs/implement.md` (in `node_modules/@autonoma-ai/sdk/docs/implement.md` once installed).

Reading order:

1. `docs/overview.md` - what the Environment Factory is and how scenarios-as-code work.
2. `docs/implement.md` - step-by-step setup: install, write scenarios, wire the handler, return auth, validate.
3. `docs/scenarios.md` - authoring scenarios: `name`/`description`/`up`/`down` and the `{ auth, teardown }` return.
4. `docs/factories.md` - legacy `defineFactory` migration reference; do not use it for new v2 integrations.
5. `docs/protocol.md` - the HTTP wire protocol, the teardown token, and error codes.
6. `docs/validation.md` - dry-running scenarios with `checkScenario`.

Key facts that differ from older docs: this is **Scenario v2** (protocol `2.0`). You author named scenarios with `defineScenario({ name, description, up, down? })`; `up({ testRunId })` returns `{ auth?, teardown? }`. The handler config carries only `sharedSecret`, `signingSecret`, and `scenarios` - there is no `scopeField`, no `factories` registry, and no top-level `auth` callback (auth is returned per-scenario from `up`). The main entry is `handleRequest`, wrapped by a server adapter (`createHandler`, `createExpressHandler`, `createHonoHandler`, `createNodeHandler`). `auth` is `{ cookies?, headers?, credentials? }` - there is no `token` field. Seed unique values from `testRunId` with `uniqueEmail`/`uniqueSlug`/`uniqueId`/`uniqueToken`.

<!-- END:autonoma-agent-rules -->
