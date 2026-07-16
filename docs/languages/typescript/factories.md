# Writing factories (TypeScript)

A factory tells the SDK how to create and delete one model using your own code. You register one factory per model the platform can create, and pass them all to the handler as `factories`. This page is the exact contract; read it before writing any.

## The shape

```typescript
// factories/organization.ts
import { defineFactory } from '@autonoma-ai/sdk'
import { z } from 'zod'
import { prisma } from '@/lib/db'

export const Organization = defineFactory({
  inputSchema: z.object({
    name: z.string(),
    slug: z.string(),
  }),
  create: async (data, ctx) => {
    const org = await prisma.organization.create({ data })
    return { id: org.id, ...data }
  },
  teardown: async (record, ctx) => {
    await prisma.organization.delete({ where: { id: record.id as string } })
  },
})
```

`defineFactory` is a typed identity helper - it validates the shape at startup and infers `data`'s type from `inputSchema`, so you never write a manual `z.infer<...>`. `z` comes from `zod`, a peer dependency you install alongside the SDK.

## inputSchema (required)

A Zod schema describing the fields this model accepts in the create payload. It does two jobs:

1. The SDK validates each incoming record against it before calling `create`.
2. The SDK derives the discover schema from it - there is no database introspection, so this schema is how the platform learns your model exists and what fields it has.

**Include every foreign key in the input schema, including the scope field.** By the time `create` runs, the SDK has already resolved every `_ref` to the real ID of the referenced record, so a FK arrives as a plain value:

```typescript
// factories/user.ts
export const User = defineFactory({
  inputSchema: z.object({
    name: z.string(),
    email: z.string(),
    organizationId: z.string(),   // arrives as the real Organization id, not a _ref
  }),
  create: async (data) => {
    const user = await createUser(data)   // reuse your real signup code
    return { id: user.id, email: user.email }
  },
})
```

## create(data, ctx)

Creates exactly one record and returns it.

- `data` - the validated input, typed from `inputSchema`. FK fields are already real IDs.
- `ctx` - `{ refs, scenarioName, testRunId }`. `refs` holds everything created so far this run, keyed by model, if you need to look something up.
- **Return value** - must include at least the primary key `id`. If it does not, the SDK fails the request with `FACTORY_MISSING_PK`. Everything you return is stored in `refs`, passed to the auth callback, and later handed to `teardown` - so return whatever teardown or auth will need (typically the id, plus fields like `email`).

Reuse your application's real creation path (`createUser`, `createOrganization`, a service method). That is the entire point: the test user gets the same password hash, defaults, and side effects a real user would.

## teardown(record, ctx) - optional

Deletes one record. The SDK calls it once per created record, in reverse dependency order, during `down`.

- `record` - exactly what your `create` returned (validated through `refSchema` first, if you set one).
- If you omit `teardown`, the model is never deleted on `down`. Provide it for every model you create, or those rows leak.

```typescript
teardown: async (record) => {
  await prisma.user.delete({ where: { id: record.id as string } })
}
```

## refSchema - optional

A Zod schema for the record `create` returns. When set, the SDK validates the stored record against it before `teardown`, and `record` is typed from it (no `as string` casts needed):

```typescript
export const User = defineFactory({
  inputSchema: z.object({ name: z.string(), email: z.string(), organizationId: z.string() }),
  refSchema: z.object({ id: z.string(), email: z.string() }),
  create: async (data) => {
    const user = await createUser(data)
    return { id: user.id, email: user.email }
  },
  teardown: async (record) => {
    await prisma.user.delete({ where: { id: record.id } })   // record.id is typed string
  },
})
```

## Registering factories

Collect every factory into one object keyed by model name - the key must match the model name the platform sends in `create`:

```typescript
// factories/index.ts
import { Organization } from './organization'
import { User } from './user'
import { Member } from './member'

export const factories = {
  Organization,
  User,
  Member,
}
```

Pass that object as `factories` when you create the handler (see `implement.md`). Every model that appears in a scenario must have an entry here, or the request fails with `INVALID_BODY` ("no factory registered for model ...").
