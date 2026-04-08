# @autonoma-ai/sdk-drizzle

Drizzle ORM adapter for the Autonoma SDK. Introspects your Drizzle schema, creates records in FK order, and tears down scoped test data.

## Install

```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/sdk-drizzle
```

## Usage

```typescript
import { drizzleAdapter } from '@autonoma-ai/sdk-drizzle'
import { db } from '~/db'
import * as schema from '~/db/schema'

const adapter = drizzleAdapter(db, schema, { scopeField: 'organizationId' })
```

Pass the adapter to your server handler:

```typescript
// app/api/autonoma/route.ts
import { createHandler } from '@autonoma-ai/server-web'
import { drizzleAdapter } from '@autonoma-ai/sdk-drizzle'
import { db } from '~/db'
import * as schema from '~/db/schema'

export const POST = createHandler({
  adapter: drizzleAdapter(db, schema, { scopeField: 'organizationId' }),
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

## Peer dependencies

Requires `drizzle-orm >= 0.30.0`.

## Documentation

Full docs: [docs/](../../docs/) — see [setup guide](../../docs/setup.txt) and [validation](../../docs/validation.txt).
