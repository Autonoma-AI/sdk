# @autonoma-ai/server-express

Express/Fastify server adapter for the Autonoma SDK.

## Install

```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/sdk-prisma @autonoma-ai/server-express
```

## Usage

### Express

```typescript
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
```

### Fastify

```typescript
import Fastify from 'fastify'
import { createExpressHandler } from '@autonoma-ai/server-express'

const app = Fastify()
const handler = createExpressHandler(config)

app.post('/api/autonoma', async (req, reply) => {
  await handler(req.raw, reply.raw)
})
```

> **Note:** Do not add `express.json()` middleware before this route. The adapter needs the raw body string to verify the HMAC signature.

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

Full docs: [docs/](../../docs/) — see [setup guide](../../docs/setup.txt).
