# Legacy factory compatibility (TypeScript migration)

Scenario v2 does not use factories. Author new integrations with ordinary code inside `defineScenario` as described in `implement.md` and `scenarios.md`.

This page exists only for projects migrating older customer code that already calls `defineFactory`. The helper is not registered with the handler, is not discoverable, and is never invoked by the v2 protocol. Do not introduce it in a new v2 integration.

## Temporary use during migration

Existing helper calls may remain temporarily while their creation and cleanup behavior moves into scenario-owned functions. New v2 code should call those functions directly from `up` and `down`.

## The shape

```typescript
import { defineFactory } from '@autonoma-ai/sdk'
import { z } from 'zod'
import { db } from '@/lib/db'

const userFactory = defineFactory({
  inputSchema: z.object({
    email: z.string(),
    orgId: z.string(),
  }),
  create: async (data, ctx) => {
    const user = await db.user.create({ data })
    return { id: user.id, email: user.email }
  },
  teardown: async (record, ctx) => {
    await db.user.delete({ where: { id: record.id } })
  },
})
```

- `inputSchema` (Zod) validates the create payload. `z.infer` of it becomes the type of `data` in `create`.
- `create(data, ctx)` runs your real creation code and returns a record that includes at least the primary key.
- `teardown?(record, ctx)` optionally deletes the record. Omit it and the factory creates but does not delete.
- `refSchema?` (Zod) optionally types the returned record.

`ctx` is a `FactoryContext`: `{ refs, scenarioName, testRunId }`. `zod` is a peer dependency; install it only if you use these helpers.

## Using a factory from a scenario

A factory is a plain object you call yourself; wire its output into your scenario's `teardown` so `down` can undo it.

```typescript
import { defineScenario } from '@autonoma-ai/sdk'

export const withUser = defineScenario({
  name: 'with-user',
  description: 'One user created through the user factory',
  up: async ({ testRunId }) => {
    const ctx = { refs: {}, scenarioName: 'with-user', testRunId }
    const user = await userFactory.create(
      { email: `u+${testRunId}@example.com`, orgId: 'org_1' },
      ctx,
    )
    return { teardown: { user } }
  },
  down: async ({ teardown }) => {
    await userFactory.teardown?.(teardown.user, { refs: {}, scenarioName: 'with-user', testRunId: '' })
  },
})
```

## Payload-topo helpers

For the specific case of creating a batch of interlinked records, the package also exports `resolvePayloadTree` and `computeTeardownOrder`, which resolve a set of records with `_alias`/`_ref` edges into create/teardown order. These are internal conveniences for the factory idiom and, like `defineFactory`, are not part of the wire protocol. Most scenarios never need them - a loop in `up` that creates records in dependency order is usually clearer.
