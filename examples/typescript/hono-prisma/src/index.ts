// =============================================================================
// Autonoma SDK — Hono + Prisma Example
// =============================================================================
// This file sets up a minimal Hono server with the Autonoma Environment
// Factory endpoint. The endpoint allows Autonoma to discover your schema,
// create test data, and tear it down — all automatically.

import { serve } from '@hono/node-server'
import { PrismaClient } from '@prisma/client'
import { prismaExecutor } from '@autonoma-ai/sdk-prisma'
import { createHonoHandler } from '@autonoma-ai/server-hono'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// 1. Initialize Prisma
// ---------------------------------------------------------------------------
// PrismaClient connects to your PostgreSQL database. It also contains the
// metadata about your schema that the Autonoma SDK will introspect.
const prisma = new PrismaClient()

// ---------------------------------------------------------------------------
// 2. Create the Hono app
// ---------------------------------------------------------------------------
const app = new Hono()

// ---------------------------------------------------------------------------
// 3. Mount the Autonoma endpoint
// ---------------------------------------------------------------------------
// This single line is the entire integration. The SDK handles:
//   - HMAC signature verification (using sharedSecret)
//   - Schema introspection (via the database's information_schema)
//   - Entity creation with FK ordering (topological sort)
//   - Scoped teardown (deletes all data matching the scope field value)
//   - Ref token signing (using signingSecret, so Autonoma can't forge refs)
app.post(
  '/api/autonoma',
  createHonoHandler({
    // The Prisma executor wraps PrismaClient into a SQL executor.
    executor: prismaExecutor(prisma),

    // The scope field tells the SDK which field to use for data isolation.
    scopeField: 'organizationId',

    // Shared secret — both you and Autonoma know this.
    // Used to verify that incoming requests are genuinely from Autonoma.
    sharedSecret: process.env.AUTONOMA_SHARED_SECRET ?? 'my-shared-secret',

    // Signing secret — only you know this. Autonoma never sees it.
    // Used to sign ref tokens so they can't be tampered with.
    signingSecret: process.env.AUTONOMA_SIGNING_SECRET ?? 'my-signing-secret',

    // Auth callback — called after entity creation during `up`.
    // Receives the first User record (or null) and a context with scopeValue and refs.
    // Must return auth credentials for the test runner.
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
