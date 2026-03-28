# Autonoma SDK — Next.js + Drizzle Example

A minimal Next.js application using the Autonoma SDK with Drizzle ORM.

## What this example does

This example shows how to add the Autonoma Environment Factory endpoint to a Next.js App Router application using Drizzle ORM. The endpoint allows Autonoma to discover your schema, create test data, and tear it down.

## Prerequisites

- Node.js 18+
- Docker (for PostgreSQL)

## Quick start

### 1. Start PostgreSQL

```bash
docker run --rm -d \
  --name autonoma-postgres \
  -e POSTGRES_USER=autonoma \
  -e POSTGRES_PASSWORD=autonoma \
  -e POSTGRES_DB=autonoma_example \
  -p 5432:5432 \
  postgres:16-alpine
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up the database

```bash
# Push the Drizzle schema to PostgreSQL
npx drizzle-kit push
```

### 4. Start the dev server

```bash
npm run dev
```

The server will start on http://localhost:3000.

### 5. Test it

```bash
BODY='{"action":"discover"}'
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "my-shared-secret" | awk '{print $2}')

curl -X POST http://localhost:3000/api/autonoma \
  -H "Content-Type: application/json" \
  -H "x-signature: $SIGNATURE" \
  -d "$BODY"
```

### 6. Clean up

```bash
docker stop autonoma-postgres
```

## Project structure

```
├── src/
│   ├── app/
│   │   └── api/
│   │       └── autonoma/
│   │           └── route.ts     # Autonoma endpoint (App Router route handler)
│   └── db/
│       ├── index.ts             # Drizzle client
│       └── schema.ts            # Database schema (tables, relations)
├── drizzle.config.ts            # Drizzle Kit configuration
├── package.json
└── tsconfig.json
```

## How it works

With Next.js App Router + Drizzle, the integration is a single route handler:

```typescript
// src/app/api/autonoma/route.ts
import { createHandler } from '@autonoma-ai/server-web'
import { drizzleAdapter } from '@autonoma-ai/sdk-drizzle'
import { db } from '@/db'
import * as schema from '@/db/schema'

export const POST = createHandler({
  adapter: drizzleAdapter(db, schema, { scopeField: 'organizationId' }),
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
})
```

The `server-web` package uses the Web standard `Request`/`Response` API, which is what Next.js App Router route handlers use natively.
