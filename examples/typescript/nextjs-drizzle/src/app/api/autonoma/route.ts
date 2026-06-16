// =============================================================================
// Autonoma SDK — Next.js App Router Route Handler (Factory-driven)
// =============================================================================
// The SDK is factory-driven: every model the dashboard can create has a
// registered factory whose `inputSchema` (Zod) drives both validation and
// the discover schema. There is no SQL introspection, no SQL fallback, and
// no executor — your factories call whatever client / repository your app
// already has.
//
// Route: POST /api/autonoma

import { z } from 'zod'
import { createHandler } from '@autonoma-ai/server-web'
import { defineFactory } from '@autonoma-ai/sdk'
import { OrganizationRepository } from '@/repositories/organization'
import { UserRepository } from '@/repositories/user'

// ---------------------------------------------------------------------------
// Initialize Repositories
// ---------------------------------------------------------------------------
const organizationRepo = new OrganizationRepository()
const userRepo = new UserRepository()

// ---------------------------------------------------------------------------
// Factory schemas
// ---------------------------------------------------------------------------
// Drizzle schemas often use snake_case columns; we keep that convention in
// `inputSchema` to match what the dashboard sends in `create.<table>[i]`.
const OrganizationInput = z.object({ name: z.string() })
const OrganizationRef = z.object({ id: z.string(), name: z.string() })
const UserInput = z.object({
  email: z.string(),
  name: z.string(),
  organization_id: z.string(),
})

// ---------------------------------------------------------------------------
// Create the Autonoma handler
// ---------------------------------------------------------------------------
export const POST = createHandler({
  // The column that scopes all models to a tenant.
  scopeField: 'organizationId',
  // Shared with Autonoma — verifies incoming requests via HMAC-SHA256.
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET ?? 'my-shared-secret',
  // Private to your server only — signs the refs token so teardown only
  // deletes what was created.
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET ?? 'my-signing-secret',

  // Required: the endpoint returns 404 unless this is true. The SDK never
  // inspects NODE_ENV — tie it to your own condition to keep it off in prod,
  // e.g. `process.env.NODE_ENV !== 'production'`.
  allowProduction: true,

  // One factory per model. With Drizzle the natural factory key is the
  // table name (`organizations`, `users`); the dashboard uses these keys
  // verbatim in the discover schema and create payload.
  factories: {
    organizations: defineFactory({
      inputSchema: OrganizationInput,
      refSchema: OrganizationRef,
      create: async (data) => organizationRepo.create({ name: data.name }),
      teardown: async (record) => organizationRepo.delete(record.id),
    }),

    users: defineFactory({
      inputSchema: UserInput,
      create: async (data) =>
        userRepo.create({
          email: data.email,
          name: data.name,
          organizationId: data.organization_id,
        }),
    }),
  },

  // Called after `up` — returns credentials so Autonoma can make
  // authenticated requests as the test user.
  auth: async () => ({ headers: { Authorization: 'Bearer test-token' } }),
})
