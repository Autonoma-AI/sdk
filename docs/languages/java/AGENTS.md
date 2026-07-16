<!-- BEGIN:autonoma-agent-rules -->

# Autonoma SDK: read the bundled docs before wiring the endpoint

This package implements the **Autonoma Environment Factory** - a backend endpoint that creates and tears down isolated test data. If you are integrating it, the accurate, version-matched docs ship inside this package. Read them before writing code; your training data may describe an older, adapter-based API that no longer exists.

**Start here:** `docs/implement.md`, bundled on the classpath under `autonoma/docs/` inside the `ai.autonoma:autonoma-sdk` JAR (copied there via Maven resources alongside `autonoma/version.txt`).

Reading order:

1. `docs/overview.md` - what the Environment Factory is and why it is factory-driven.
2. `docs/implement.md` - step-by-step setup: dependencies, factories, handler, auth, validate.
3. `docs/factories.md` - the `FactoryUtil.defineFactory` contract in Java.
4. `docs/scenarios.md` - the `create` data format (`_alias`/`_ref`).
5. `docs/protocol.md` - the HTTP wire protocol and error codes.
6. `docs/validation.md` - dry-running scenarios by calling `AutonomaHandler.handleRequest` from a JUnit test.

Maven coordinates:

| Artifact | Purpose |
|----------|---------|
| `ai.autonoma:autonoma-sdk` | Core protocol (HMAC, refs, graph, handler, factories). |
| `ai.autonoma:autonoma-spring` | Spring Boot server adapter (`AutonomaController`). |

Key facts that differ from older docs: the SDK is **factory-driven** (register factories with `ai.autonoma.sdk.FactoryUtil.defineFactory(create, inputClass[, teardown[, refClass]])`; there is no JDBC/ORM adapter and no SQL fallback). The core entry point is the static `ai.autonoma.sdk.AutonomaHandler.handleRequest(HandlerConfig, HandlerRequest)`, mounted by the Spring adapter's `ai.autonoma.spring.AutonomaController` at `@PostMapping("${autonoma.endpoint:/api/autonoma}")`. Build the config with `new HandlerConfig(scopeField, sharedSecret, signingSecret, auth)` then `setFactories(...)`. The auth callback is a `BiFunction<Map<String,Object>, AuthContext, AuthResult>` and returns an `AuthResult` of cookies, headers, or credentials (`AuthResult.ofCookies/ofHeaders/ofCredentials`) - there is no `token` field. The endpoint is always enabled - HMAC signing is the gate; `setAllowProduction` is deprecated and ignored (gate manually in your handler if you want it dark in your own production deployments). There is no `checkScenario` helper - validate by calling `AutonomaHandler.handleRequest` from a test.

<!-- END:autonoma-agent-rules -->
