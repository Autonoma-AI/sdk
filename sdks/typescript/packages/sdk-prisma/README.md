# @autonoma-ai/sdk-prisma

Prisma ORM adapter for the Autonoma SDK. Introspects your Prisma schema, creates records in FK order, and tears down scoped test data.

## Install

```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/sdk-prisma
```

## Usage

```typescript
import { prismaAdapter } from '@autonoma-ai/sdk-prisma'
import { prisma } from '@/lib/db'

const adapter = prismaAdapter(prisma, { scopeField: 'organizationId' })
```

Pass the adapter to your server handler:

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
    return { headers: { Authorization: `Bearer ${session.token}` } }
  },
})
```

## Scope field

The scope field is the FK that most models use to reference a root tenant entity — usually `organizationId`, `orgId`, `tenantId`, or `workspaceId`.

During `up`: child records inherit the scope value automatically via nesting.
During `down`: the adapter deletes everything where `scopeField = <root entity ID>`.

## Integration test

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { PrismaClient } from '@prisma/client'
import { prismaAdapter } from '@autonoma-ai/sdk-prisma'
import { checkScenario } from '@autonoma-ai/sdk'
import { execSync } from 'node:child_process'

describe('environment factory', () => {
  let container, prisma, adapter

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()
    execSync('npx prisma db push --skip-generate --accept-data-loss', {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasourceUrl: container.getConnectionUri() })
    adapter = prismaAdapter(prisma, { scopeField: 'organizationId' })
  }, 60_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await container.stop()
  })

  it('creates and tears down data', async () => {
    const result = await checkScenario(adapter, {
      create: {
        Organization: [{
          name: 'Test [{{testRunId}}]',
          slug: 'test-{{testRunId}}',
          users: [{ email: 'admin-{{testRunId}}@test.com', name: 'Admin' }],
        }],
      },
    })
    expect(result.valid).toBe(true)
  })
})
```

## Peer dependencies

Requires `@prisma/client >= 5.0.0`.

## Documentation

Full docs: [docs/](../../docs/) — see [setup guide](../../docs/setup.txt) and [validation](../../docs/validation.txt).
