# @autonoma-ai/sdk-drizzle

Drizzle ORM adapter for the Autonoma SDK. Introspects your Drizzle schema, creates records in FK order, and tears down scoped test data.

## Install

```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/sdk-drizzle
```

## Usage

```typescript
import { drizzleExecutor } from '@autonoma-ai/sdk-drizzle'
import { db } from '~/db'

const executor = drizzleExecutor(db)
```

Pass the executor to your server handler:

```typescript
// app/api/autonoma/route.ts
import { createHandler } from '@autonoma-ai/server-web'
import { drizzleExecutor } from '@autonoma-ai/sdk-drizzle'
import { db } from '~/db'

export const POST = createHandler({
  executor: drizzleExecutor(db),
  scopeField: 'organizationId',
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  auth: async (user, context) => {
    const session = await createSession(user.id as string)
    return { headers: { Authorization: `Bearer ${session.token}` } }
  },
})
```

## Scope field

The scope field is the FK that most models use to reference a root tenant entity — usually `organizationId`, `orgId`, `tenantId`, or `workspaceId`.

During `up`: child records inherit the scope value automatically via nesting.
During `down`: the adapter deletes everything where `scopeField = <root entity ID>`.

## Peer dependencies

Requires `drizzle-orm >= 0.30.0`.

## Documentation

Full docs: [docs/](../../docs/) — see [setup guide](../../docs/setup.txt) and [validation](../../docs/validation.txt).
