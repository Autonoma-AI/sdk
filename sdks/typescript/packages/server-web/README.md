# @autonoma-ai/server-web

Web standard server adapter for the Autonoma SDK. Works with Next.js App Router, Hono, Bun, and Deno — any framework that uses the standard `Request`/`Response` API.

## Install

```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/sdk-prisma @autonoma-ai/server-web
```

## Usage

### Next.js App Router

```typescript
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

### Hono

```typescript
import { Hono } from 'hono'
import { createHandler } from '@autonoma-ai/server-web'

const app = new Hono()
const handler = createHandler(config)

app.post('/api/autonoma', (c) => handler(c.req.raw))
```

### Bun

```typescript
import { createHandler } from '@autonoma-ai/server-web'

const handler = createHandler(config)

Bun.serve({
  fetch(req) {
    if (req.method === 'POST' && new URL(req.url).pathname === '/api/autonoma') {
      return handler(req)
    }
    return new Response('Not found', { status: 404 })
  },
})
```

## Auth callback

The `auth` callback receives the first `User` created during setup and must return real credentials that the test runner can use to log in:

```typescript
// Session cookie
auth: async (user) => {
  const session = await createSession(user.id as string)
  return {
    cookies: [{ name: 'session', value: session.token, httpOnly: true, sameSite: 'lax', path: '/' }],
  }
}

// Bearer token
auth: async (user) => {
  const token = jwt.sign({ sub: user.id }, SECRET)
  return { token }
}
```

## Documentation

Full docs: [docs/](../../docs/) — see [setup guide](../../docs/setup.txt).
