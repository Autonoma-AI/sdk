# Implement the endpoint (TypeScript)

Follow these steps to stand up a working Environment Factory endpoint. This is written for a coding agent doing the integration; do the steps in order and do not skip the validation step.

## Prerequisites

- A TypeScript backend on Node.js 18+.
- A database and the client your app already uses (Prisma, Drizzle, Kysely, raw `pg` - it does not matter; your factories call it).
- `zod` (a peer dependency of the SDK).

## Step 1 - Detect the stack and pick packages

Install the core package, `zod`, and the one server adapter that matches the app's HTTP framework:

| Framework | Server adapter package | Handler export |
|-----------|------------------------|----------------|
| Next.js App Router, Bun, Deno | `@autonoma-ai/server-web` | `createHandler` |
| Express, Fastify | `@autonoma-ai/server-express` | `createExpressHandler` |
| Hono | `@autonoma-ai/server-hono` | `createHonoHandler` |
| Node `http` | `@autonoma-ai/server-node` | `createNodeHandler` |

```bash
# example: Next.js App Router
pnpm add @autonoma-ai/sdk @autonoma-ai/server-web zod
```

Use the project's package manager (pnpm, npm, yarn, bun). There is no ORM adapter package to install - the SDK is factory-driven.

## Step 2 - Generate the two secrets

```bash
openssl rand -hex 32   # AUTONOMA_SHARED_SECRET
openssl rand -hex 32   # AUTONOMA_SIGNING_SECRET  (must be different)
```

Add both to `.env` (and placeholders to `.env.example` if it exists). The SDK throws `SAME_SECRETS` at startup if they match.

```env
# .env
AUTONOMA_SHARED_SECRET=...   # shared with Autonoma
AUTONOMA_SIGNING_SECRET=...  # private, never shared
```

## Step 3 - Find the scope field

Read the database schema. Find the foreign key that appears on the most models and points at a single root entity - commonly `organizationId`, `orgId`, `tenantId`, or `workspaceId`. That is the scope field. The root model itself (e.g. `Organization`) does not carry it.

Confirm the field, the endpoint path, and the app's auth mechanism with the user before writing code.

## Step 4 - Write a factory per model

Write one factory for each model the platform will create, calling your app's real creation code. See `factories.md` for the full contract. Collect them into one registry:

```typescript
// factories/index.ts
export const factories = { Organization, User, Member, Application /* ... */ }
```

## Step 5 - Wire the handler

Create the config once and pass it to your adapter's handler function. The config carries the scope field, both secrets, the factory registry, and the auth callback.

```typescript
// app/api/autonoma/route.ts  (Next.js App Router)
import { createHandler } from '@autonoma-ai/server-web'
import { factories } from '@/factories'
import { createSession } from '@/lib/auth'   // your app's real session code

export const POST = createHandler({
  scopeField: 'organizationId',
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  factories,
  auth: async (user, ctx) => {
    const session = await createSession(user!.id as string)
    return {
      cookies: [{ name: 'session', value: session.token, httpOnly: true, sameSite: 'lax', path: '/' }],
    }
  },
})
```

Other frameworks use the same config object, only the mounting differs:

```typescript
// Express
import { createExpressHandler } from '@autonoma-ai/server-express'
app.post('/api/autonoma', createExpressHandler(config))

// Hono
import { createHonoHandler } from '@autonoma-ai/server-hono'
app.post('/api/autonoma', createHonoHandler(config))

// Node http
import { createNodeHandler } from '@autonoma-ai/server-node'
http.createServer(createNodeHandler(config)).listen(3000)
```

## Step 6 - Implement the auth callback

This is the part that most often breaks tests, so get it right. The callback receives the first created `User` record (or `null` if the scenario made none) and `ctx` with `scopeValue` and `refs`. It must return **real, working credentials** using the app's actual auth mechanism. If it returns a fake or hardcoded token, every test fails at login.

The return type is `{ cookies?, headers?, credentials? }` - there is no top-level `token` field. Pick the shape that matches how your app authenticates:

```typescript
// Session cookie (most web apps)
auth: async (user) => {
  const session = await createSession(user!.id as string)
  return { cookies: [{ name: 'session', value: session.token, httpOnly: true, sameSite: 'lax', path: '/' }] }
}

// JWT bearer token (APIs, SPAs) - the token goes in a header
auth: async (user) => {
  const token = jwt.sign({ sub: user!.id }, process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { headers: { Authorization: `Bearer ${token}` } }
}

// Email + password (the runner logs in through the UI, e.g. mobile)
auth: async (user) => ({
  credentials: { email: user!.email as string, password: 'test-password-123' },
})
```

For the email/password shape, the `User` factory must create the record with a matching password hash, so a real login succeeds.

## Step 7 - Production gating (optional)

The endpoint is always enabled - HMAC signing is the gate, and unsigned requests get `401`. The old `allowProduction` flag is deprecated and ignored. On Autonoma preview environments (`AUTONOMA_PREVIEWKIT` is set) nothing more is needed - previews are isolated and never production. If you deploy the factory in your own environments and want it dark in production anyway, gate it in your handler with your own condition:

```typescript
// app/api/autonoma/route.ts
const handler = createHandler({ /* ... */ })
export const POST = (req: Request) =>
  process.env.NODE_ENV === 'production'
    ? new Response('Not Found', { status: 404 })
    : handler(req)
```

## Step 8 - Validate before deploying

Dry-run your scenarios against a real database with `checkScenario` and iterate until they pass. See `validation.md`. Never ship a scenario you have not validated.

## Step 9 - Smoke-test with curl

```bash
SECRET="your-shared-secret"
BODY='{"action":"discover"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/.*= //')
curl -s -X POST http://localhost:3000/api/autonoma \
  -H "Content-Type: application/json" -H "x-signature: $SIG" -d "$BODY" | jq .
```

Expected: a JSON schema listing your models and `scopeField`. A `404` means the route is not mounted; a `401` means the secret does not match.

## Step 10 - Report and connect

Tell the user the endpoint path, confirm all scenarios pass, and hand off:

1. Set `AUTONOMA_SHARED_SECRET` and `AUTONOMA_SIGNING_SECRET` in staging/production env.
2. Deploy the endpoint.
3. Paste `AUTONOMA_SHARED_SECRET` into the Autonoma dashboard when connecting the app.

## Rules

**Do:**
- Reuse the app's existing DB client and real creation code inside factories.
- Return real credentials from `auth` using the app's own session/JWT logic.
- Register a factory (with a `teardown`) for every model any scenario creates.
- Match the project's conventions: import style, file layout, naming.
- Validate every scenario with `checkScenario` before deploying.

**Do not:**
- Implement HMAC, token signing, or teardown ordering yourself - the SDK owns all of it.
- Return a hardcoded token like `"test-token"` from `auth`.
- Use the same value for `sharedSecret` and `signingSecret`.
- Set `id`, defaulted fields, or auto timestamps in scenario data.
- Expect the SDK to inject the scope field or wire any FK - you set every FK as a `_ref`.
