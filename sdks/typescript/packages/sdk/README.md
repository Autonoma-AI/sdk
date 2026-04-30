# @autonoma-ai/sdk

Core protocol layer for the Autonoma Environment Factory. Handles HMAC verification, JWT-signed teardown tokens, dependency ordering from `_alias`/`_ref` graphs, and the `discover`/`up`/`down` request lifecycle.

This package is the shared dependency of all server adapters — you don't need to install it directly unless you're building a custom adapter.

## Install

```bash
pnpm add @autonoma-ai/sdk
```

## What's exported

### `handleRequest(config, request)`

Main entry point. Routes `discover`, `up`, and `down` actions, verifies HMAC, and delegates to registered factories.

```typescript
import { handleRequest } from '@autonoma-ai/sdk'

const response = await handleRequest(config, { body, headers })
// { status: 200, body: { ... } }
```

### `defineFactory({ inputSchema, create, teardown?, refSchema? })`

Defines a factory for a model. `inputSchema` is a Zod schema that the SDK uses to derive the discover response — no database introspection needed.

```typescript
import { defineFactory } from '@autonoma-ai/sdk'
import { z } from 'zod'

const Organization = defineFactory({
  inputSchema: z.object({ name: z.string(), slug: z.string() }),
  create: async (data, ctx) => {
    const org = await db.organization.create({ data })
    return { id: org.id, ...data }
  },
  teardown: async (record, ctx) => {
    await db.organization.delete({ where: { id: record.id } })
  },
})
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
      _alias: 'org1',
    }],
  },
})

// result.valid   -> true/false
// result.phase   -> 'ok' | 'up' | 'down'
// result.errors  -> [{ message, fix }]
// result.timing  -> { upMs, downMs }
```

### Graph utilities (`@autonoma-ai/sdk/graph`)

Exported from the `/graph` subpath:

```typescript
import { topoSort, findDeferrableEdge } from '@autonoma-ai/sdk/graph'
```

- `topoSort(edges)` — Kahn's algorithm + Tarjan's SCC for dependency ordering
- `findDeferrableEdge(scc, edges)` — finds a nullable FK in a cycle to break it

### Other exports

| Export | Use |
|--------|-----|
| `signBody` / `verifySignature` | HMAC-SHA256 signing for request auth |
| `signRefs` / `verifyRefs` | JWT-like token for signing teardown refs |
| `fingerprint` | Deterministic hash of scenario definitions |

## Documentation

Full docs: [docs/](../../docs/) — start with [overview](../../docs/overview.txt) or read [everything in one file](../../docs/llms-full.txt).
