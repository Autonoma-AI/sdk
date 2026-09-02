# Overview

The Autonoma Environment Factory is a single endpoint in your backend that provisions fresh, isolated test data before an end-to-end test run and tears it down afterward. This SDK implements that endpoint for you.

## Why it exists

Every end-to-end test needs data. A test for "user adds an item to the cart" needs a user, some products, and a cart. A test for "admin views analytics" needs an organization with users, runs, and history.

Tests cannot share data. If one test deletes a product, another test that expects ten products fails. Running tests in parallel makes this worse. The Environment Factory gives each test run its own data, then tears it down when the run finishes. No interference, no leftover rows.

## Scenarios: ordinary code in your repo

In this SDK a **scenario** is a named piece of your own code that provisions an environment. You author it with `defineScenario` (or your language's equivalent): a `name`, a `description`, an `up` function, and an optional `down` function. `up` is free-form async code - loops, conditionals, real API calls, calls into your own service layer - that provisions the environment a test needs. `down` tears it back down.

There is no declarative "create graph", no schema introspection, and no ORM adapter. You write the provisioning logic exactly as you would write it by hand; the SDK owns only the envelope around it.

## How it works

The platform talks to one HTTP POST endpoint that you mount in your app (you choose the path, e.g. `/api/autonoma`). The endpoint handles three actions:

| Action | What the platform asks | What the SDK does |
|--------|------------------------|-------------------|
| `discover` | "What scenarios can you run?" | Returns the `{ name, description }` of every registered scenario. |
| `up` | "Run scenario X for this test run." | Looks the scenario up by name, runs its `up({ testRunId })`, signs a teardown token carrying the scenario name and `teardown` handle, and returns `auth` and the `teardownToken`. |
| `down` | "Tear scenario X down." | Verifies the token, recovers the scenario name and `teardown` handle, and calls that scenario's `down({ name, teardown })`. |

You do not write routing, signature checks, token signing, or expiry handling. You write scenarios, and the SDK does the rest.

## What `up` returns

A scenario's `up` returns up to two optional things:

- **`auth`** - credentials the test runner uses to act as the seeded user (`cookies`, `headers`, and/or `credentials`). Secrets live here. `auth` keeps its redaction discipline.
- **`teardown`** - any JSON handle your `down` needs to find and delete what `up` created. Signed into the teardown token; handed back to `down` verbatim. It never reaches a test in the clear.

### Seeding unique values

When `up` provisions records with unique columns (a user email, an org slug), the values must differ per run so parallel runs never collide, yet be reproducible so a later `down` can recompute them. The SDK ships uniqueness helpers seeded from `testRunId` (`uniqueEmail`, `uniqueSlug`, `uniqueId`, `uniqueToken`) that give you deterministic-per-run values without storing anything - `up` and a later `down` compute identical values from the same `testRunId`.

## What you provide

Three things, passed as configuration when you create the handler:

| Config | What it is |
|--------|------------|
| `scenarios` | The scenarios the platform can run, each built with `defineScenario`. |
| `sharedSecret` | Shared with Autonoma. Verifies that incoming requests are authentic (HMAC). |
| `signingSecret` | Known only to you. Signs the teardown token so it cannot be forged. |

## The two secrets

You need two different secret values. The SDK throws `SAME_SECRETS` at startup if they match.

- **Shared secret** - both you and Autonoma hold it. Autonoma signs every request with it (HMAC-SHA256); your endpoint verifies the signature. This stops anyone else from calling your endpoint.
- **Signing secret** - only you hold it. During `up` the SDK signs a token carrying the scenario name and your `teardown` handle. During `down` it verifies that token before routing to teardown. Autonoma stores the token opaquely and passes it back; it can neither read nor forge it.

Generate them as two distinct random values:

```bash
openssl rand -hex 32   # AUTONOMA_SHARED_SECRET
openssl rand -hex 32   # AUTONOMA_SIGNING_SECRET (must differ)
```

## Migrating from SDK v1

SDK v1 used a stored declarative graph and registered model factories. That wire path is gone. Move its creation and cleanup behavior into ordinary scenario `up` and `down` code so the application and its test setup logic change in the same repository and deployment. The language-specific `factories.md` is a temporary compatibility reference, not v2 authoring guidance.

## Language availability

The SDK ships for eight languages, each an independent implementation that passes the same conformance suite. All eight are on Scenario v2 (protocol `2.0`).

| Language | Server adapters |
|----------|-----------------|
| TypeScript | Web standard (Next.js App Router, Bun, Deno), Express, Hono, Node http |
| Python | FastAPI, Flask, Django |
| Go | Gin |
| Ruby | Rails, Rack |
| Rust | Actix Web, Axum |
| Java | Spring Boot (Spring MVC) |
| PHP | Laravel |
| Elixir | Plug (Phoenix) |

See `implement.md` for the step-by-step setup in your language, `scenarios.md` for how to author scenarios, and `protocol.md` for the wire protocol.
