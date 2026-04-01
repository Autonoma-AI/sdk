// =============================================================================
// Autonoma SDK — Next.js App Router Route Handler
// =============================================================================
// This file defines the Autonoma Environment Factory endpoint as a Next.js
// App Router route handler. It uses the Web standard Request/Response API.
//
// Route: POST /api/autonoma

import { createHandler } from '@autonoma-ai/server-web'
import { drizzleAdapter } from '@autonoma-ai/sdk-drizzle'
import { db } from '@/db'
import * as schema from '@/db/schema'

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
  // The Drizzle adapter needs the db instance AND the schema object.
  // Unlike Prisma (which has metadata built into the client), Drizzle needs
  // the schema passed explicitly so it can introspect tables and relations.
  adapter: drizzleAdapter(db, schema, { scopeField: 'organizationId' }),

  // Shared secret — both you and Autonoma know this.
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET ?? 'my-shared-secret',

  // Signing secret — only you know this.
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET ?? 'my-signing-secret',
})
