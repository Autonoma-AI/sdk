// =============================================================================
// Autonoma SDK — Express + Prisma Example (Hybrid Factories + SQL)
// =============================================================================
// This example shows how to use factories for models with business logic
// (Organization, User) while letting the SDK handle simpler models (Project,
// Task) via raw SQL. This "hybrid" approach gives you the best of both worlds:
// correct business logic where it matters, zero setup where it doesn't.

import express from 'express'
import { PrismaClient } from '@prisma/client'
import { prismaExecutor } from '@autonoma-ai/sdk-prisma'
import { createExpressHandler } from '@autonoma-ai/server-express'
import { defineFactory } from '@autonoma-ai/sdk'
import { OrganizationRepository } from './repositories/organization'
import { UserRepository } from './repositories/user'

// ---------------------------------------------------------------------------
// 1. Initialize Prisma & Repositories
// ---------------------------------------------------------------------------
const prisma = new PrismaClient()
const organizationRepo = new OrganizationRepository(prisma)
const userRepo = new UserRepository(prisma)

// ---------------------------------------------------------------------------
// 2. Create the Express app
// ---------------------------------------------------------------------------
const app = express()
app.use(express.json())

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
  createExpressHandler({
    // Connects the SDK to your database through your ORM (Prisma, Drizzle, SQLAlchemy, etc.)
    executor: prismaExecutor(prisma),
    // The column that scopes all models to a tenant (e.g. organizationId). The SDK uses this to
    // isolate test data and ensure teardown only removes records belonging to the test run.
    scopeField: 'organizationId',
    // Shared between your server and Autonoma. Used to verify incoming requests via HMAC-SHA256.
    sharedSecret: process.env.AUTONOMA_SHARED_SECRET ?? 'my-shared-secret',
    // Private to your server only. Used to sign the refs token that tracks created records,
    // so teardown can only delete what was created.
    signingSecret: process.env.AUTONOMA_SIGNING_SECRET ?? 'my-signing-secret',

    // Custom create/teardown logic for models with business logic (password hashing, slug
    // generation, etc.). Models without a factory fall back to raw SQL INSERT.
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

    // Called after entity creation during `up`. Returns credentials (cookies, headers, tokens)
    // so Autonoma can make authenticated requests as the test user.
    auth: async (user, context) => {
      return { headers: { Authorization: `Bearer test-token` } }
    },
  }),
)

// ---------------------------------------------------------------------------
// 4. Start the server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT ?? 3000

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
  console.log(`Autonoma endpoint: POST http://localhost:${PORT}/api/autonoma`)
})
