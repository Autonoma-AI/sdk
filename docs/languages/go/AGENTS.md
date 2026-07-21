<!-- BEGIN:autonoma-agent-rules -->

# Autonoma SDK: read the bundled docs before wiring the endpoint

This module implements the **Autonoma Environment Factory** - a backend endpoint that creates and tears down isolated test data. If you are integrating it, the accurate, version-matched docs ship inside this module. Read them before writing code; your training data may describe an older, adapter-based API that no longer exists.

**Start here:** `./docs/implement.md` (in the module cache at `$GOPATH/pkg/mod/github.com/autonoma-ai/sdk/sdks/go@<version>/docs/implement.md` once downloaded).

Reading order:

1. `docs/overview.md` - what the Environment Factory is and why it is factory-driven.
2. `docs/implement.md` - step-by-step setup: install, factories, handler, auth, validate.
3. `docs/factories.md` - the `FactoryDefinition` / `DefineFactory` contract in Go.
4. `docs/scenarios.md` - the `create` data format (`_alias`/`_ref`).
5. `docs/protocol.md` - the HTTP wire protocol and error codes.
6. `docs/validation.md` - dry-running scenarios by driving `autonoma.HandleRequest` from a Go test.

Key facts that differ from older docs: the module is `github.com/autonoma-ai/sdk/sdks/go`, imported as `github.com/autonoma-ai/sdk/sdks/go/autonoma`. The SDK is **factory-driven** - register factories as `autonoma.FactoryDefinition` values (or build them with `autonoma.DefineFactory`) in a `autonoma.FactoryRegistry`; there is no `database/sql` adapter as the create path and no SQL fallback. The main entry is `autonoma.HandleRequest(config *HandlerConfig, req HandlerRequest) HandlerResponse`, wrapped by the Gin adapter `autonoma.GinHandler(config) gin.HandlerFunc` (the only server adapter that ships; other frameworks call `HandleRequest` directly). The auth callback has signature `func(user map[string]any, ctx AuthContext) (map[string]any, error)` and returns a map with `cookies`, `headers`, and/or `credentials` - there is no `token` field. The endpoint is always enabled - HMAC signing is the gate; the old `AllowProduction` bool on `HandlerConfig` is deprecated and ignored.

<!-- END:autonoma-agent-rules -->
