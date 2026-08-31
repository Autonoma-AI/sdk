<!-- BEGIN:autonoma-agent-rules -->

# Autonoma SDK: read the bundled docs before wiring the endpoint

This package implements the **Autonoma Environment Factory**. The accurate, version-matched docs ship in the SDK JAR under `autonoma/docs/`; older material may describe the removed factory-driven protocol.

Read in this order:

1. `docs/overview.md` - scenarios-as-code and the ownership model.
2. `docs/implement.md` - dependencies, scenarios, handler, auth, and deployment.
3. `docs/scenarios.md` - the `name`/`description`/`up`/`down` contract.
4. `docs/validation.md` - direct JUnit validation through the real handler.
5. `docs/protocol.md` - HTTP bodies, teardown tokens, and errors.
6. `docs/factories.md` - legacy factory migration reference; do not use it for new v2 integrations.

Scenario v2 uses protocol `2.0`. Define scenarios with `Scenario.define(...)`; `up` returns `ScenarioUpResult(auth, teardown)` and `down` receives only the verified teardown state. Register scenarios with `new HandlerConfig(sharedSecret, signingSecret, scenarios)`. There is no scope field, factory registry, create graph, or top-level auth callback. `AutonomaController` mounts the Spring endpoint; `AutonomaHandler.handleRequest` is the core entry point.

Maven coordinates:

| Artifact | Purpose |
|----------|---------|
| `ai.autonoma:autonoma-sdk` | Core Scenario v2 SDK. |
| `ai.autonoma:autonoma-spring` | Spring Boot adapter. |

<!-- END:autonoma-agent-rules -->
