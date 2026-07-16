# @autonoma-ai/server-web

Web standard server adapter for the Autonoma SDK. Works with Next.js App Router, Hono, Bun, and Deno — any framework that uses the standard `Request`/`Response` API.

## Install

```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/server-web zod
```

## Usage

### Next.js App Router

```typescript
// app/api/autonoma/route.ts
import { createHandler } from '@autonoma-ai/server-web'
import { defineFactory } from '@autonoma-ai/sdk'
import { z } from 'zod'

export const POST = createHandler({
  scopeField: 'organizationId',
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  factories: { Organization, User },
  auth: async (user, context) => {
    const session = await createSession(user.id as string)
    return { headers: { Authorization: `Bearer ${session.token}` } }
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

The `auth` callback receives the first `User` record created during setup (or `null` if no User model exists) and a context object with `scopeValue` and `refs`. It must return credentials for the test runner to authenticate:

```typescript
// Session cookie
auth: async (user, context) => {
  const session = await createSession(user.id as string)
  return {
    cookies: [{ name: 'session', value: session.token, httpOnly: true, sameSite: 'lax', path: '/' }],
  }
}

// Bearer token
auth: async (user, context) => {
  const token = jwt.sign({ sub: user.id }, SECRET)
  return { headers: { Authorization: `Bearer ${token}` } }
}

// Username + password (for login-page flows)
auth: async (user, context) => {
  return { credentials: { email: user.email as string, password: 'TestP@ssw0rd123!' } }
}
```

## Documentation

Full docs ship inside this package under [`docs/`](./docs/) — see [`docs/implement.md`](./docs/implement.md).
