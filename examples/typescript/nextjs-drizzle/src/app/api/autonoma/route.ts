// =============================================================================
// Autonoma SDK — Next.js App Router Route Handler (Hybrid Factories + SQL)
// =============================================================================
// This example shows how to use factories for models with business logic
// (Organization, User) while letting the SDK handle simpler models (Project,
// Task) via raw SQL. This "hybrid" approach gives you the best of both worlds:
// correct business logic where it matters, zero setup where it doesn't.
//
// Route: POST /api/autonoma

import { createHandler } from '@autonoma-ai/server-web'
import { drizzleExecutor } from '@autonoma-ai/sdk-drizzle'
import { defineFactory } from '@autonoma-ai/sdk'
import { db } from '@/db'
import { OrganizationRepository } from '@/repositories/organization'
import { UserRepository } from '@/repositories/user'

// ---------------------------------------------------------------------------
// Initialize Repositories
// ---------------------------------------------------------------------------
const organizationRepo = new OrganizationRepository()
const userRepo = new UserRepository()

// ---------------------------------------------------------------------------
// Create the Autonoma handler with Factories
// ---------------------------------------------------------------------------
// Factories let you use your own repositories/services to create test data.
// The SDK still handles scenario resolution, FK ordering, and teardown —
// but delegates actual creation to your code for models that need it.
//
// Models WITHOUT a factory (Project, Task) fall back to raw SQL INSERT,
// which works fine for simple tables without business logic.

export const POST = createHandler({
  executor: drizzleExecutor(db),
  scopeField: 'organizationId',
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET ?? 'my-shared-secret',
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET ?? 'my-signing-secret',

  // Register factories for models that have business logic
  factories: {
    // Organization: uses the repository which handles slug generation,
    // default settings, external service setup, etc.
    organizations: defineFactory({
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
    users: defineFactory({
      create: async (data, ctx) => {
        return userRepo.create({
          email: data.email as string,
          name: data.name as string,
          organizationId: data.organization_id as string,
        })
      },
    }),

    // projects and tasks have no factories — they use raw SQL INSERT.
    // This is fine because they're simple tables with no business logic.
  },

  auth: async (user, context) => {
    return { headers: { Authorization: `Bearer test-token` } }
  },
})
