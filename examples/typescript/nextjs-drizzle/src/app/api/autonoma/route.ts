// =============================================================================
// Autonoma SDK — Next.js App Router Route Handler
// =============================================================================
// This file defines the Autonoma Environment Factory endpoint as a Next.js
// App Router route handler. It uses the Web standard Request/Response API.
//
// Route: POST /api/autonoma

import { createHandler } from '@autonoma-ai/server-web'
import { drizzleExecutor } from '@autonoma-ai/sdk-drizzle'
import { db } from '@/db'

// ---------------------------------------------------------------------------
// Create the Autonoma handler
// ---------------------------------------------------------------------------
// The `server-web` package creates a handler that works with the Web standard
// Request/Response API — which is exactly what Next.js App Router uses.
//
// In Next.js, exporting a named function like `POST` from a route.ts file
// makes it handle POST requests to that path. So this single export sets up
// the entire Autonoma endpoint.

export const POST = createHandler({
  // The Drizzle executor wraps the db instance into a SQL executor.
  executor: drizzleExecutor(db),

  // The scope field tells the SDK which field to use for data isolation.
  scopeField: 'organizationId',

  // Shared secret — both you and Autonoma know this.
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET ?? 'my-shared-secret',

  // Signing secret — only you know this.
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET ?? 'my-signing-secret',

  // Auth callback — called after entity creation during `up`.
  auth: async (user, context) => {
    return { headers: { Authorization: `Bearer test-token` } }
  },
})
