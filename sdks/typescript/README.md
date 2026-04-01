# Autonoma TypeScript SDK

TypeScript implementation of the Autonoma Environment Factory SDK. Get a working factory endpoint in ~15 lines with HMAC authentication, FK-ordered entity creation, and scoped teardown.

## Packages

| Package | Description |
|---------|-------------|
| `@autonoma-ai/sdk` | Core protocol (HMAC, refs, templates, graph, handler) |
| `@autonoma-ai/sdk-prisma` | Prisma ORM adapter |
| `@autonoma-ai/sdk-drizzle` | Drizzle ORM adapter |
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
import { prismaAdapter } from '@autonoma-ai/sdk-prisma'
import { prisma } from '@/lib/db'

export const POST = createHandler({
  adapter: prismaAdapter(prisma, { scopeField: 'organizationId' }),
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  auth: async (user) => {
    const session = await createSession(user.id as string)
    return { token: session.token }
  },
})
```

### Express

```ts
import express from 'express'
import { createExpressHandler } from '@autonoma-ai/server-express'
import { prismaAdapter } from '@autonoma-ai/sdk-prisma'
import { prisma } from './db'

const app = express()

app.post('/api/autonoma', createExpressHandler({
  adapter: prismaAdapter(prisma, { scopeField: 'organizationId' }),
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  auth: async (user) => {
    const session = await createSession(user.id as string)
    return { token: session.token }
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

Full docs are in the [`docs/`](docs/) subdirectory. Start with the [overview](docs/overview.txt) or read [everything in one file](docs/llms-full.txt).

For protocol-level documentation, see the root [`protocol/`](../../protocol/) directory.
