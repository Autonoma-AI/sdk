// =============================================================================
// Autonoma SDK — Hono + Prisma Example (Hybrid Factories + SQL)
// =============================================================================
// This example shows how to use factories for models with business logic
// (Organization, User) while letting the SDK handle simpler models (Project,
// Task) via raw SQL. This "hybrid" approach gives you the best of both worlds:
// correct business logic where it matters, zero setup where it doesn't.

import { serve } from '@hono/node-server'
import { PrismaClient } from '@prisma/client'
import { prismaExecutor } from '@autonoma-ai/sdk-prisma'
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
// 2. Create the Hono app
// ---------------------------------------------------------------------------
const app = new Hono()

// ---------------------------------------------------------------------------
// 3. Mount the Autonoma endpoint with Factories
// ---------------------------------------------------------------------------
// Factories let you use your own repositories/services to create test data.
// The SDK still handles scenario resolution, FK ordering, and teardown —
// but delegates actual creation to your code for models that need it.
//
// Models WITHOUT a factory (Project, Task) fall back to raw SQL INSERT,
// which works fine for simple tables without business logic.
app.post(
  '/api/autonoma',
  createHonoHandler({
    executor: prismaExecutor(prisma),
    scopeField: 'organizationId',
    sharedSecret: process.env.AUTONOMA_SHARED_SECRET ?? 'my-shared-secret',
    signingSecret: process.env.AUTONOMA_SIGNING_SECRET ?? 'my-signing-secret',

    // Register factories for models that have business logic
    factories: {
      // Organization: uses the repository which handles slug generation,
      // default settings, external service setup, etc.
      Organization: defineFactory({
        create: async (data, ctx) => {
          return organizationRepo.create({
            name: data.name as string,
          })
        },
        teardown: async (record, ctx) => {
          await organizationRepo.delete(record.id as string)
        },
      }),

      // User: uses the repository which handles password hashing,
      // email normalization, and other business logic.
      // No teardown defined — the SDK falls back to SQL DELETE.
      User: defineFactory({
        create: async (data, ctx) => {
          return userRepo.create({
            email: data.email as string,
            name: data.name as string,
            organizationId: data.organizationId as string,
          })
        },
      }),

      // Project and Task have no factories — they use raw SQL INSERT.
      // This is fine because they're simple tables with no business logic.
    },

    auth: async (user, context) => {
      return { headers: { Authorization: `Bearer test-token` } }
    },
  }),
)

// ---------------------------------------------------------------------------
// 4. Start the server
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Server running on http://localhost:${PORT}`)
  console.log(`Autonoma endpoint: POST http://localhost:${PORT}/api/autonoma`)
})
