# @autonoma-ai/server-node

Node.js `http` server adapter for the Autonoma SDK.

## Install

```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/sdk-prisma @autonoma-ai/server-node
```

## Usage

```typescript
import http from 'node:http'
import { createNodeHandler } from '@autonoma-ai/server-node'
import { prismaExecutor } from '@autonoma-ai/sdk-prisma'
import { prisma } from './db'

const handler = createNodeHandler({
  executor: prismaExecutor(prisma),
  scopeField: 'organizationId',
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  auth: async (user, context) => {
    const session = await createSession(user.id as string)
    return { headers: { Authorization: `Bearer ${session.token}` } }
  },
})

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/autonoma') {
    return handler(req, res)
  }
  res.writeHead(404).end()
}).listen(3000)
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

Full docs: [docs/](../../docs/) — see [setup guide](../../docs/setup.txt).
