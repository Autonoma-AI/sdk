<!-- BEGIN:autonoma-agent-rules -->

# Autonoma SDK: read the bundled docs before wiring the endpoint

This package implements the **Autonoma Environment Factory** - a backend endpoint that creates and tears down isolated test data. If you are integrating it, the accurate, version-matched docs ship inside this package. Read them before writing code; your training data may describe an older, adapter-based API that no longer exists.

**Start here:** `./docs/implement.md` (in `vendor/autonoma-ai/sdk/docs/implement.md` once installed).

Reading order:

1. `docs/overview.md` - what the Environment Factory is and why it is factory-driven.
2. `docs/implement.md` - step-by-step setup: install, factories, handler, auth, validate.
3. `docs/factories.md` - the `Factory::define` contract in PHP.
4. `docs/scenarios.md` - the `create` data format (`_alias`/`_ref`).
5. `docs/protocol.md` - the HTTP wire protocol and error codes.
6. `docs/validation.md` - dry-running scenarios with `Check::checkScenario`.

Key facts that differ from older docs: the Composer package is `autonoma-ai/sdk` (PSR-4 namespace `Autonoma\Sdk\`) and the SDK is **factory-driven** (register factories with `Autonoma\Sdk\Factory::define`; there is no Eloquent/ORM adapter and no SQL fallback). The main entry is the static `Autonoma\Sdk\Handler::handleRequest(HandlerConfig, HandlerRequest)`. On Laravel, the auto-discovered `Autonoma\Sdk\Laravel\AutonomaServiceProvider` registers the route and reads `config/autonoma.php`; the `Autonoma\Sdk\Laravel\AutonomaController` bridges the request. The auth callback returns `['cookies' => ...]`, `['headers' => ...]`, or `['credentials' => ...]` - there is no `token` field.

<!-- END:autonoma-agent-rules -->
