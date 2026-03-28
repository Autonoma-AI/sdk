# Autonoma SDK — Express + Prisma Example

A minimal Express.js application using the Autonoma SDK with Prisma ORM.

## What this example does

This example shows how to wire up the Autonoma Environment Factory endpoint in an Express app using Prisma as the ORM. The endpoint allows Autonoma to:

1. **Discover** your database schema (models, fields, relationships)
2. **Create** test data (scoped to a test run)
3. **Tear down** test data when done

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
# Generate the Prisma client from the schema
npx prisma generate

# Create the tables in PostgreSQL
npx prisma db push
```

### 4. Start the server

```bash
npm start
```

The server will start on http://localhost:3000.

### 5. Test it

You can verify the endpoint is working by sending a discover request:

```bash
# Generate an HMAC signature for the request body
BODY='{"action":"discover"}'
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "my-shared-secret" | awk '{print $2}')

# Send the request
curl -X POST http://localhost:3000/api/autonoma \
  -H "Content-Type: application/json" \
  -H "x-signature: $SIGNATURE" \
  -d "$BODY"
```

You should see a JSON response with your schema metadata.

### 6. Clean up

```bash
docker stop autonoma-postgres
```

## Project structure

```
├── prisma/
│   └── schema.prisma    # Database schema (models, relations)
├── src/
│   └── index.ts         # Express server + Autonoma endpoint
├── package.json
└── tsconfig.json
```

## How it works

The key integration is just a few lines in `src/index.ts`:

```typescript
import { prismaAdapter } from '@autonoma-ai/sdk-prisma'
import { createExpressHandler } from '@autonoma-ai/server-express'

// Wire up the Autonoma endpoint
app.post('/api/autonoma', createExpressHandler({
  adapter: prismaAdapter(prisma, { scopeField: 'organizationId' }),
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
}))
```

That's it. The SDK introspects your Prisma schema automatically — no manual configuration of models or fields needed.
