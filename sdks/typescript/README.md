# Autonoma TypeScript SDK

TypeScript implementation of the Autonoma Environment Factory SDK. Get a working factory endpoint in ~15 lines with HMAC authentication, FK-ordered entity creation, and scoped teardown.

## Packages

| Package | Description |
|---------|-------------|
| `@autonoma-ai/sdk` | Core protocol (HMAC, refs, graph, handler) |
| `@autonoma-ai/sdk-prisma` | Prisma ORM adapter |
| `@autonoma-ai/sdk-drizzle` | Drizzle ORM adapter |
| `@autonoma-ai/sdk-pg` | PostgreSQL driver adapter |
| `@autonoma-ai/sdk-mysql2` | MySQL driver adapter |
| `@autonoma-ai/server-web` | Web standard handler (Next.js App Router, Hono, Bun, Deno) |
| `@autonoma-ai/server-express` | Express handler |
| `@autonoma-ai/server-node` | Node.js `http` handler |

## Quick Start

### Install

```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/sdk-prisma @autonoma-ai/server-web
```

### Next.js App Router + Prisma

```ts
// app/api/autonoma/route.ts
import { createHandler } from '@autonoma-ai/server-web'
import { prismaExecutor } from '@autonoma-ai/sdk-prisma'
import { prisma } from '@/lib/db'

export const POST = createHandler({
  executor: prismaExecutor(prisma),
  scopeField: 'organizationId',
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  auth: async (user, context) => {
    const session = await createSession(user.id as string)
    return { headers: { Authorization: `Bearer ${session.token}` } }
  },
})
```

### Express

```ts
import express from 'express'
import { createExpressHandler } from '@autonoma-ai/server-express'
import { prismaExecutor } from '@autonoma-ai/sdk-prisma'
import { prisma } from './db'

const app = express()

app.post('/api/autonoma', createExpressHandler({
  executor: prismaExecutor(prisma),
  scopeField: 'organizationId',
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  auth: async (user, context) => {
    const session = await createSession(user.id as string)
    return { headers: { Authorization: `Bearer ${session.token}` } }
  },
}))

app.listen(3000)
```

## Model name ↔ table name

By default, the SDK derives a model name from each SQL table by splitting on `_` and PascalCasing each part — **no pluralization**. Examples:

| SQL table | Auto-derived model name |
|-----------|-------------------------|
| `user` | `User` |
| `api_key` | `ApiKey` |
| `branch_deployment` | `BranchDeployment` |
| `organizations` | `Organizations` (stays plural) |
| `api_keys` | `ApiKeys` (stays plural) |

If every factory you register is keyed under the auto-derived name, **omit `tableNameMap` entirely**. The SDK handles the mapping.

You only need `tableNameMap` when a factory key disagrees with the auto-derived name. Common reasons:

- Your tables are plural but you want singular factory keys: `organizations` table ↔ `Organization` key.
- Legacy short names: `usr` table ↔ `User` key, `acl` table ↔ `AccessControl` key.

The map is **sparse, not exhaustive**: only list entries that actually differ. Auto-derivation covers the rest.

```ts
// Tables in DB: organization, user, api_key, deal   (singular)
// Factories keyed: Organization, User, ApiKey, Deal
// tableNameMap: undefined  // auto-derive is exact; omit the field

// Tables in DB: organizations, users, api_keys
// Factories keyed singular → every entry disagrees:
createHandler({
  // ...
  tableNameMap: {
    Organization: 'organizations',
    User: 'users',
    ApiKey: 'api_keys',
  },
  factories: { Organization: ..., User: ..., ApiKey: ... },
})
```

**Red flag:** if your `tableNameMap` has one entry per factory and every entry is just a plural↔singular rename, consider keeping factory keys plural (`Organizations`) and dropping the map entirely. Plural keys are valid — pick whichever convention your scenarios use.

## Commands

```bash
pnpm install   # install all workspace deps
pnpm build     # build all packages (turbo + tsup)
pnpm test      # run all tests (vitest)
```

## Documentation

For protocol-level documentation, see the root [`protocol/`](../../protocol/) directory. For runnable examples, see [`examples/typescript/`](../../examples/typescript/).
