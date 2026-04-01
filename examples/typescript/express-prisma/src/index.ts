// =============================================================================
// Autonoma SDK — Express + Prisma Example
// =============================================================================
// This file sets up a minimal Express server with the Autonoma Environment
// Factory endpoint. The endpoint allows Autonoma to discover your schema,
// create test data, and tear it down — all automatically.

import express from 'express'
import { PrismaClient } from '@prisma/client'
import { prismaAdapter } from '@autonoma-ai/sdk-prisma'
import { createExpressHandler } from '@autonoma-ai/server-express'

// ---------------------------------------------------------------------------
// 1. Initialize Prisma
// ---------------------------------------------------------------------------
// PrismaClient connects to your PostgreSQL database. It also contains the
// metadata about your schema that the Autonoma SDK will introspect.
const prisma = new PrismaClient()

// ---------------------------------------------------------------------------
// 2. Create the Express app
// ---------------------------------------------------------------------------
const app = express()

// Express needs to parse JSON request bodies for most routes. However, the
// Autonoma handler reads the raw body itself (for HMAC signature verification),
// so we use express.json() here for any other routes you might add.
app.use(express.json())

// ---------------------------------------------------------------------------
// 3. Mount the Autonoma endpoint
// ---------------------------------------------------------------------------
// This single line is the entire integration. The SDK handles:
//   - HMAC signature verification (using sharedSecret)
//   - Schema introspection (via Prisma's metadata)
//   - Entity creation with FK ordering (topological sort)
//   - Scoped teardown (deletes all data matching the scope field value)
//   - Ref token signing (using signingSecret, so Autonoma can't forge refs)
app.post(
  '/api/autonoma',
  createExpressHandler({
    // The Prisma adapter introspects your schema automatically.
    // `scopeField` tells it which field to use for data isolation.
    adapter: prismaAdapter(prisma, { scopeField: 'organizationId' }),

    // Shared secret — both you and Autonoma know this.
    // Used to verify that incoming requests are genuinely from Autonoma.
    sharedSecret: process.env.AUTONOMA_SHARED_SECRET ?? 'my-shared-secret',

    // Signing secret — only you know this. Autonoma never sees it.
    // Used to sign ref tokens so they can't be tampered with.
    signingSecret: process.env.AUTONOMA_SIGNING_SECRET ?? 'my-signing-secret',
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
