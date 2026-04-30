# Autonoma TypeScript SDK

TypeScript implementation of the Autonoma Environment Factory SDK. Define typed factories with Zod schemas, and the SDK handles HMAC authentication, dependency-ordered entity creation, and scoped teardown.

## Packages

| Package | Description |
|---------|-------------|
| `@autonoma-ai/sdk` | Core protocol (HMAC, refs, graph, handler, schema) |
| `@autonoma-ai/server-web` | Web standard handler (Next.js App Router, Hono, Bun, Deno) |
| `@autonoma-ai/server-express` | Express handler |
| `@autonoma-ai/server-node` | Node.js `http` handler |

## Quick Start

### Install

```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/server-web zod
```

### Next.js App Router

```ts
// app/api/autonoma/route.ts
import { createHandler } from '@autonoma-ai/server-web'
import { defineFactory } from '@autonoma-ai/sdk'
import { z } from 'zod'

const Organization = defineFactory({
  inputSchema: z.object({ name: z.string(), slug: z.string() }),
  create: async (data) => {
    const org = await db.organization.create({ data })
    return { id: org.id, ...data }
  },
  teardown: async (record) => {
    await db.organization.delete({ where: { id: record.id } })
  },
})

export const POST = createHandler({
  scopeField: 'organizationId',
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  factories: { Organization },
  auth: async (user) => {
    const session = await createSession(user.id as string)
    return { headers: { Authorization: `Bearer ${session.token}` } }
  },
})
```

### Express

```ts
import express from 'express'
import { createExpressHandler } from '@autonoma-ai/server-express'
import { defineFactory } from '@autonoma-ai/sdk'
import { z } from 'zod'

const app = express()

app.post('/api/autonoma', createExpressHandler({
  scopeField: 'organizationId',
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  factories: { Organization, User },
  auth: async (user) => {
    const session = await createSession(user.id as string)
    return { headers: { Authorization: `Bearer ${session.token}` } }
  },
}))

app.listen(3000)
```

## Commands

```bash
pnpm install   # install all workspace deps
pnpm build     # build all packages (turbo + tsup)
pnpm test      # run all tests (vitest)
```

## Documentation

For protocol-level documentation, see the root [`protocol/`](../../protocol/) directory. For runnable examples, see [`examples/typescript/`](../../examples/typescript/).
