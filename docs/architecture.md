# Autonoma SDK — Architecture Guide

## What problem does this solve?

Autonoma runs E2E tests against your app. Before each test, it needs a known database state: an organization with users, apps, test data, etc. After the test, it needs to clean up without affecting other data.

Customers used to implement this by hand — a single POST endpoint with 400-800 lines of code handling entity creation, FK ordering, auth, and teardown. Teardown bugs accounted for ~40% of onboarding support tickets.

The SDK reduces this to ~15 lines. You provide your Prisma client and a JSON scenario definition. The SDK handles everything else.

## How it works — the 30-second version

```
Autonoma platform                          Your backend (SDK)
─────────────────                          ──────────────────

POST /api/autonoma
{ action: "up", environment: "standard" }  → Creates org, users, apps, tests, etc.
                                           ← Returns auth token + refs + signed token

(runs the test using the auth token)

POST /api/autonoma
{ action: "down", refsToken: "..." }       → Deletes everything it created
                                           ← { ok: true }
```

## Package structure

```
@autonoma/sdk              Core protocol (framework/ORM agnostic)
@autonoma/sdk-prisma       Prisma adapter (schema introspection, create, teardown)
@autonoma/sdk-drizzle      Drizzle adapter (same interface, different ORM)
@autonoma/server-web       Web standard Request/Response (Next.js, Hono, Bun)
@autonoma/server-express   Express req/res adapter
@autonoma/server-node      Node http adapter
```

A customer installs the core SDK + one ORM adapter + one server adapter:

```
pnpm add @autonoma/sdk @autonoma/sdk-prisma @autonoma/server-web
```

Their endpoint:

```typescript
import { createHandler } from '@autonoma/server-web'
import { prismaAdapter } from '@autonoma/sdk-prisma'
import { prisma } from './db'
import scenarios from './scenarios.json'

const adapter = prismaAdapter(prisma, { scopeField: 'organizationId' })

export const POST = createHandler({
  adapter,
  secret: process.env.AUTONOMA_SECRET,
  scenarios: { scenarios },
  auth: async (user) => {
    const token = await createSessionToken(user.id)
    return { token }
  },
})
```

## Core SDK (`@autonoma/sdk`)

This package owns all protocol logic. It never touches a database directly.

### handler.ts — Request routing

The entry point. Receives a `HandlerRequest` (raw body + headers), returns a `HandlerResponse` (status + JSON body).

Flow:
1. **Environment gating** — blocks in production unless `allowProduction: true`
2. **HMAC verification** — validates `x-signature` header against the request body using the shared secret
3. **Action dispatch** — routes to `discover`, `up`, or `down`

### The three actions

**`discover`** — Returns a list of available environments (scenario names + fingerprints). The Autonoma platform calls this to know what scenarios are available.

**`up`** — Creates test data. This is the complex one:
1. Finds the scenario by name
2. Reads FK edges from the schema → topological sort to determine creation order
3. For each model in order:
   - Resolves template expressions (`{{testRunId}}`, `{{refs.Organization[0].id}}`, `{{cycle(...)}}`)
   - Injects the scope field (FK to the root organization) if the model has it
   - Calls `adapter.createEntities()` to insert into the DB
   - Stores created records in a `refs` accumulator for subsequent models to reference
4. Calls the `auth` callback with the first User to get an auth token
5. Signs the refs into a JWT-like token for teardown

**`down`** — Deletes test data:
1. Verifies the signed refs token
2. Calls `adapter.teardown(scopeValue, refs)` to delete everything

### template.ts — Expression engine

Resolves `{{...}}` expressions in scenario field values:

| Expression | Result | Example |
|---|---|---|
| `{{testRunId}}` | Unique run ID | `"a3f2b1c4"` |
| `{{index}}` / `{{index1}}` | 0-based / 1-based index | `0`, `1` |
| `{{refs.Model[i].field}}` | Value from a previously created entity | `"clx9abc..."` |
| `{{cycle([...])}}` | Cycles through values by index | `"active"`, `"draft"`, `"active"` |
| `{{random.int(a,b)}}` | Random integer | `2473` |
| `{{now()}}` | ISO timestamp | `"2024-01-15T..."` |

When the entire field value is a single expression, the type is preserved (number stays number). When mixed with text, everything becomes a string.

### graph.ts — FK ordering

Uses Kahn's algorithm for topological sort + Tarjan's SCC for cycle detection.

**Why this is needed:** If User has `organizationId → Organization`, the Organization must be created first. The scenario JSON doesn't specify order — the SDK reads the FK graph and figures it out.

**Circular FKs:** Some schemas have cycles (e.g., Test ↔ TestGroup where TestGroup.defaultTestId → Test and Test.testGroupId → TestGroup). The algorithm:
1. Kahn's detects which nodes can't be sorted (non-zero in-degree)
2. Tarjan's identifies the exact cycle
3. Finds a nullable FK in the cycle (e.g., TestGroup.defaultTestId is nullable)
4. Creates TestGroup first with `defaultTestId = null`, then creates Test with the real testGroupId
5. Models that depend on cycle members are sorted in a second pass after treating cycle nodes as resolved

### validate.ts — Static validation

Checks scenario JSON against the schema before hitting the DB:
- Model names exist (with case suggestions: `"organisation"` → `"Did you mean 'Organisation'?"`)
- Field names exist on the model
- Required fields without defaults are present
- `{{refs.X[i]}}` targets exist in the scenario with sufficient count
- Batch entities aren't referenced by other entities
- FK dependencies are satisfiable

### check.ts — Dry-run validation

Goes beyond static validation by running the full up→down cycle against a real database:
- Catches unique constraint violations, enum mismatches, type errors
- Returns structured errors with fix suggestions
- Used in the LLM generation loop: generate → check → fix → check → ship

### fingerprint.ts — Scenario hashing

SHA-256 hash (16-char hex) of the scenario's entity spec. Used by the Autonoma platform to detect when a scenario definition has changed.

### hmac.ts / refs.ts — Security

- **HMAC-SHA256**: Every request is signed. The SDK verifies the signature before processing.
- **Refs token**: A JWT-like `header.payload.signature` that contains all created entity IDs. Signed by the shared secret. Teardown verifies this token before deleting anything.

## Prisma Adapter (`@autonoma/sdk-prisma`)

Implements the `OrmAdapter` interface using Prisma Client.

### introspect.ts — Schema extraction

Reads Prisma's DMMF (Data Model Meta Format) from `prisma._runtimeDataModel.models`. Extracts:
- **Models** — name, scalar fields, which fields are required/have defaults/are IDs
- **FK edges** — which model holds a FK to which other model
- **Relations** — the name of the relation field on the parent (e.g., `"applications"` on Organization), used by the nested tree format
- Handles `@updatedAt` and `@default(...)` correctly (Prisma reports `@updatedAt` as `hasDefaultValue: false` but the SDK treats it as auto-managed)

### create.ts — Entity creation

Two modes:
- **Normal** (`batch: false`): Individual `prisma.model.create({ data })` calls inside a `$transaction`. Returns all created records for the refs accumulator.
- **Batch** (`batch: true`): Single `prisma.model.createMany({ data: [...] })` call. Much faster (10k records in ~500ms vs minutes) but doesn't return records — batch entities can't be referenced by other entities.

### teardown.ts — Scoped deletion

Deletes everything associated with a test run:
1. Finds the **scope root model** (e.g., Organization) by following FK edges
2. Builds a map of **which FK field name each model uses** to point to the scope root (handles mixed casing like `organizationId` vs `organizationID`)
3. **Breaks circular FKs** by nullifying the nullable edge
4. **Deletes scoped models** in reverse topological order (`deleteMany WHERE fkField = scopeValue`)
5. **Deletes unscoped models** (like User, connected through a join table) by their record IDs from the refs token
6. **Deletes the scope root** last (`deleteMany WHERE id = scopeValue`)

## Scenario format

A scenario is a JSON object describing what data to create:

```json
{
  "name": "standard",
  "entities": {
    "Organization": {
      "count": 1,
      "fields": { "name": "Acme [{{testRunId}}]", "slug": "acme-{{testRunId}}" }
    },
    "User": {
      "count": 1,
      "fields": { "email": "admin-{{testRunId}}@test.com", "name": "Admin" }
    },
    "Member": {
      "count": 1,
      "fields": {
        "userId": "{{refs.User[0].id}}",
        "organizationId": "{{refs.Organization[0].id}}",
        "role": "owner"
      }
    },
    "Application": {
      "count": 3,
      "fields": {
        "name": "{{cycle(['Web','Android','iOS'])}}",
        "organizationId": "{{refs.Organization[0].id}}",
        "architecture": "{{cycle(['WEB','ANDROID','IOS'])}}"
      }
    },
    "Run": {
      "count": 10000,
      "batch": true,
      "fields": {
        "testId": "{{refs.Test[0].id}}",
        "status": "{{cycle(['passed','passed','failed','running'])}}"
      }
    }
  }
}
```

Key rules:
- **Model names are PascalCase** and must match the Prisma schema exactly
- **IDs and `@default` fields** are omitted — the DB generates them
- **The scope field** (e.g., `organizationId`) is injected automatically by the SDK — don't include it unless the scenario provides it via `{{refs.*}}`
- **`batch: true`** uses `createMany` for speed but records aren't available in refs
- **`{{refs.Model[i].field}}`** references are resolved at creation time based on the topo-sorted order

## The scope field

Every test run is isolated through a "scope field" — typically `organizationId`. The SDK:
- **On `up`**: injects the scope field into every model that has a FK to the scope root
- **On `down`**: deletes all records where the scope field equals the scope value

The scope value is the `id` of the root entity (e.g., the created Organization's id). This means each test run gets its own Organization, and teardown only deletes records under that Organization.

Models without the scope field (e.g., User connected through a Member join table) are deleted by their record IDs from the signed refs token.

## Validation flow for LLM-generated scenarios

The SDK is designed to be used in a generate→validate→fix loop:

```
┌─────────────────────────────────────────────────┐
│  LLM reads:                                      │
│    1. autonoma-schema.json (the DB schema)       │
│    2. AUTONOMA.md (the app's knowledge base)     │
│    3. This architecture doc                      │
│                                                   │
│  LLM generates scenario JSON                     │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  Static validation (npx autonoma validate)       │
│    - Model names, field names, refs bounds        │
│    - Required fields, FK dependencies             │
│    - Exit code 0 = pass, 1 = errors with fixes   │
└──────────────────┬──────────────────────────────┘
                   │ if errors: LLM reads fix suggestions, edits JSON, retries
                   ▼
┌─────────────────────────────────────────────────┐
│  DB dry-run (checkScenario)                      │
│    - Spins up test DB (testcontainers)           │
│    - Runs full up→down cycle                     │
│    - Catches: unique constraints, enum errors,   │
│      type mismatches, FK ordering issues          │
│    - Returns structured errors with fix advice    │
└──────────────────┬──────────────────────────────┘
                   │ if errors: LLM reads Prisma error + fix, edits JSON, retries
                   ▼
┌─────────────────────────────────────────────────┐
│  Scenario is valid. Ship it.                     │
│    - Drop JSON into the project                  │
│    - SDK endpoint handles up/down automatically   │
└─────────────────────────────────────────────────┘
```

## Known limitations

- **Flat format can't distribute refs across instances**: `count: 5` Members all point to `refs.User[0].id`. Can't express "member[i] uses user[i]". Workaround: use `count: 1` or wait for the nested tree format.
- **Self-referential hierarchies**: Folder with `parentId → Folder.id` can't express parent-child nesting in the flat format. All instances are created flat with `parentId = null`.
- **Json fields**: The SDK can't validate or generate complex Json field shapes (e.g., `applicationMetadata`). Use `{}` or `[]` as placeholders, or implement a `beforeCreate` hook.
- **Auth is customer-provided**: The SDK doesn't know how to create auth sessions for BetterAuth, WorkOS, or other providers. The `auth` callback is where customers implement this.
- **Mixed FK casing**: Navigator uses both `organizationId` and `organizationID`. The SDK handles this by matching case-insensitively when detecting scope fields.
