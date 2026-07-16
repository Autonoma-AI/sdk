// =============================================================================
// Autonoma SDK — Express + Prisma Example (Factory-driven)
// =============================================================================
// The SDK is factory-driven: every model the dashboard can create has a
// registered factory whose `inputSchema` (Zod) drives both validation and
// the discover schema. There is no SQL introspection, no SQL fallback, and
// no executor — your factories call whatever services / repositories your
// app already has.

import express from 'express'
import { z } from 'zod'
import { PrismaClient } from '@prisma/client'
import { createExpressHandler } from '@autonoma-ai/server-express'
import { defineFactory } from '@autonoma-ai/sdk'
import {
  createOrganization,
  deleteOrganization,
} from './repositories/organization'
import { createUser } from './repositories/user'

// ---------------------------------------------------------------------------
// 1. Initialize Prisma
// ---------------------------------------------------------------------------
// This example wires factories via free functions. The Python example shows
// the same thing with class-based repositories — both work equally well.
const prisma = new PrismaClient()

// ---------------------------------------------------------------------------
// 2. Declare the factory schemas
// ---------------------------------------------------------------------------
// Every field the dashboard sends in `create.<Model>[i]` should appear here.
// `defineFactory` infers `data`'s type from this schema — no z.infer<...>
// annotations needed at the call site.
const OrganizationInput = z.object({
  name: z.string(),
})

const OrganizationRef = z.object({
  id: z.string(),
  name: z.string(),
})

const UserInput = z.object({
  email: z.string(),
  name: z.string(),
  organizationId: z.string(),
})

// ---------------------------------------------------------------------------
// 3. Create the Express app
// ---------------------------------------------------------------------------
const app = express()
app.use(express.json())

// ---------------------------------------------------------------------------
// 4. Mount the Autonoma endpoint
// ---------------------------------------------------------------------------
app.post(
  '/api/autonoma',
  createExpressHandler({
    // The column that scopes all models to a tenant (e.g. organizationId).
    scopeField: 'organizationId',
    // Shared with Autonoma — verifies incoming requests via HMAC-SHA256.
    sharedSecret: process.env.AUTONOMA_SHARED_SECRET ?? 'my-shared-secret',
    // Private to your server only — signs the refs token so teardown only
    // deletes what was created.
    signingSecret: process.env.AUTONOMA_SIGNING_SECRET ?? 'my-signing-secret',

    // One factory per model the dashboard can create. Each declares an
    // `inputSchema` (required) plus a `create` (and optional `teardown`).
    factories: {
      Organization: defineFactory({
        inputSchema: OrganizationInput,
        refSchema: OrganizationRef,
        create: async (data) => createOrganization(prisma, { name: data.name }),
        teardown: async (record) => deleteOrganization(prisma, record.id),
      }),

      // `data` is automatically typed as { email: string; name: string; organizationId: string }
      User: defineFactory({
        inputSchema: UserInput,
        create: async (data) =>
          createUser(prisma, {
            email: data.email,
            name: data.name,
            organizationId: data.organizationId,
          }),
      }),
    },

    // Called after `up` — returns credentials so Autonoma can make
    // authenticated requests as the test user.
    auth: async () => ({ headers: { Authorization: 'Bearer test-token' } }),
  }),
)

// ---------------------------------------------------------------------------
// 5. Start the server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT ?? 3000

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
  console.log(`Autonoma endpoint: POST http://localhost:${PORT}/api/autonoma`)
})
