# @autonoma-ai/sdk

Core protocol layer for the Autonoma Environment Factory. Handles HMAC verification, JWT-signed teardown tokens, FK graph ordering, and the `discover`/`up`/`down` request lifecycle.

This package is the shared dependency of all ORM and server adapters — you don't need to install it directly unless you're building a custom adapter.

## Install

```bash
pnpm add @autonoma-ai/sdk
```

## What's exported

### `handleRequest(config, request)`

Main entry point. Routes `discover`, `up`, and `down` actions, verifies HMAC, and delegates to the ORM adapter.

```typescript
import { handleRequest } from '@autonoma-ai/sdk'

const response = await handleRequest(config, { body, headers })
// { status: 200, body: { ... } }
```

### `checkScenario(adapter, scenario)`

Dry-run a scenario against a real database — full create-then-teardown cycle. Use this in integration tests to validate scenario data before deploying.

```typescript
import { checkScenario } from '@autonoma-ai/sdk'

const result = await checkScenario(adapter, {
  create: {
    Organization: [{
      name: 'Test Org',
      slug: 'test-org',
      users: [{ email: 'admin@test.com', name: 'Admin' }],
    }],
  },
})

// result.valid   → true/false
// result.phase   → 'ok' | 'up' | 'down'
// result.errors  → [{ message, fix }]
// result.timing  → { upMs, downMs }
```

### `checkAllScenarios(adapter, scenarios)`

Runs `checkScenario` for each scenario definition and returns all results.

### Graph utilities (`@autonoma-ai/sdk/graph`)

Exported from the `/graph` subpath for use in ORM adapters:

```typescript
import { topoSort, findDeferrableEdge } from '@autonoma-ai/sdk/graph'
```

- `topoSort(edges)` — Kahn's algorithm + Tarjan's SCC for FK-ordered entity creation
- `findDeferrableEdge(scc, edges)` — finds a nullable FK in a cycle to break it

### Other exports

| Export | Use |
|--------|-----|
| `signBody` / `verifySignature` | HMAC-SHA256 signing for request auth |
| `signRefs` / `verifyRefs` | JWT-like token for signing teardown refs |
| `resolveTree` | Nested scenario tree → flat entity list with auto-wired FKs |
| `fingerprint` | Deterministic hash of scenario definitions |

## Documentation

Full docs: [docs/](../../docs/) — start with [overview](../../docs/overview.txt) or read [everything in one file](../../docs/llms-full.txt).
