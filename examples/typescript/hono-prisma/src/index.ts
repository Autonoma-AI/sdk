// =============================================================================
// Autonoma SDK — Hono + Prisma Example (Factory-driven)
// =============================================================================
// The SDK is factory-driven: every model the dashboard can create has a
// registered factory whose `inputSchema` (Zod) drives both validation and
// the discover schema. There is no SQL introspection, no SQL fallback, and
// no executor — your factories call whatever services / repositories your
// app already has.

import { serve } from '@hono/node-server'
import { z } from 'zod'
import { PrismaClient } from '@prisma/client'
import { createHonoHandler } from '@autonoma-ai/server-hono'
import { defineFactory } from '@autonoma-ai/sdk'
import { Hono } from 'hono'
import { OrganizationRepository } from './repositories/organization'
import { UserRepository } from './repositories/user'

// ---------------------------------------------------------------------------
// 1. Initialize Prisma & Repositories
// ---------------------------------------------------------------------------
const prisma = new PrismaClient()
const organizationRepo = new OrganizationRepository(prisma)
const userRepo = new UserRepository(prisma)

// ---------------------------------------------------------------------------
// 2. Declare the factory schemas
// ---------------------------------------------------------------------------
const OrganizationInput = z.object({ name: z.string() })
const OrganizationRef = z.object({ id: z.string(), name: z.string() })
const UserInput = z.object({
  email: z.string(),
  name: z.string(),
  organizationId: z.string(),
})

// ---------------------------------------------------------------------------
// 3. Create the Hono app
// ---------------------------------------------------------------------------
const app = new Hono()

// ---------------------------------------------------------------------------
// 4. Mount the Autonoma endpoint
// ---------------------------------------------------------------------------
app.post(
  '/api/autonoma',
  createHonoHandler({
    scopeField: 'organizationId',
    sharedSecret: process.env.AUTONOMA_SHARED_SECRET ?? 'my-shared-secret',
    signingSecret: process.env.AUTONOMA_SIGNING_SECRET ?? 'my-signing-secret',

    factories: {
      Organization: defineFactory({
        inputSchema: OrganizationInput,
        refSchema: OrganizationRef,
        create: async (data) => organizationRepo.create({ name: data.name }),
        teardown: async (record) => organizationRepo.delete(record.id),
      }),

      User: defineFactory({
        inputSchema: UserInput,
        create: async (data) =>
          userRepo.create({
            email: data.email,
            name: data.name,
            organizationId: data.organizationId,
          }),
      }),
    },

    auth: async () => ({ headers: { Authorization: 'Bearer test-token' } }),
  }),
)

// ---------------------------------------------------------------------------
// 5. Start the server
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Server running on http://localhost:${PORT}`)
  console.log(`Autonoma endpoint: POST http://localhost:${PORT}/api/autonoma`)
})
