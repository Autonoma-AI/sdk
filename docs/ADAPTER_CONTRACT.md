# Adapter Contracts

This document defines the interfaces that adapter packages must implement to work with `@autonoma/sdk`. There are three adapter types: ORM, Server, and Auth (future).

## ORM Adapter

Implemented by: `@autonoma/sdk-prisma`, `@autonoma/sdk-drizzle`

An ORM adapter connects the SDK to a specific database ORM. It must implement `OrmAdapter`:

```typescript
interface OrmAdapter {
  /**
   * Introspect the ORM schema and return metadata.
   * Called on every request (should cache internally).
   *
   * Must return:
   * - All models with their scalar/enum fields
   * - All FK edges (which model references which)
   * - All relation mappings (parent field names → child models)
   * - The scope field name
   */
  getSchema(): SchemaInfo

  /**
   * Create entities in the database.
   *
   * @param spec - Model name → { count, fields[], batch? }
   *   - fields[] is an array of already-resolved field objects (templates resolved, FKs set)
   *   - If batch is true, use bulk insert (e.g., createMany). Records are NOT returned.
   *   - If batch is false, create individually and return all created records.
   *
   * @param context - { testRunId, refs } for reference
   *
   * @returns Record<modelName, createdRecords[]>
   *   - Each record should include at minimum the `id` field
   *   - Batch entities return an empty array
   */
  createEntities(
    spec: Record<string, ResolvedEntitySpec>,
    context: CreateContext,
  ): Promise<Record<string, Record<string, unknown>[]>>

  /**
   * Delete all data scoped to a test run.
   *
   * @param scopeValue - The ID of the scope root entity (e.g., the Organization's id)
   * @param refs - Optional: all created records from the `up` call, keyed by model name.
   *   Used for targeted deletion of models that don't have the scope field directly.
   *
   * Teardown must:
   * 1. Find the scope root model (the model whose id = scopeValue)
   * 2. Find all models with a FK to the scope root
   * 3. Handle circular FKs (nullify nullable edges before deleting)
   * 4. Delete scoped models in reverse topological order
   * 5. Delete non-scoped models by their record IDs from refs
   * 6. Delete the scope root entity last
   *
   * Must not throw if records are already deleted (idempotent).
   */
  teardown(
    scopeValue: string,
    refs?: Record<string, Record<string, unknown>[]>,
  ): Promise<void>
}
```

### SchemaInfo contract

```typescript
interface SchemaInfo {
  models: ModelInfo[]          // Every model in the database
  edges: FKEdge[]              // Every FK relationship
  relations: SchemaRelation[]  // Parent field → child model mappings
  scopeField: string           // The FK name used for test isolation
}

interface ModelInfo {
  name: string      // PascalCase model name (e.g., "User")
  fields: FieldInfo[]
}

interface FieldInfo {
  name: string      // camelCase field name (e.g., "email")
  type: string      // "String", "Int", "Float", "Boolean", "DateTime", "Json", or enum name
  isRequired: boolean
  isId: boolean     // Primary key
  hasDefault: boolean  // DB or ORM provides a value (includes @default, @updatedAt, autoincrement, etc.)
}

interface FKEdge {
  from: string      // Model that HOLDS the FK column
  to: string        // Model being REFERENCED
  localField: string // FK column name on `from`
  foreignField: string // PK column name on `to` (usually "id")
  nullable: boolean // Whether the FK is optional
}

interface SchemaRelation {
  parentModel: string   // Model with the relation field (e.g., "Organization")
  childModel: string    // The related model (e.g., "User")
  parentField: string   // Relation field name on parent (e.g., "users")
  childField: string    // FK column that links them (e.g., "organizationId")
}
```

### What the SDK provides to adapters

The SDK exports graph utilities that adapters can reuse:

```typescript
import { topoSort, findDeferrableEdge } from '@autonoma/sdk'

// topoSort(modelNames, edges) → { sorted: string[], cycles: string[][] }
// findDeferrableEdge(cycle, edges) → FKEdge | null (the nullable edge to break the cycle)
```

### Implementation checklist for a new ORM adapter

1. **`getSchema()`**: Introspect the ORM's metadata (DMMF for Prisma, schema objects for Drizzle, etc.)
   - Extract all scalar/enum fields (skip relation fields)
   - Mark `@updatedAt`, `@default(...)`, and auto-generated fields as `hasDefault: true`
   - Extract FK edges from relation declarations
   - Extract relations: list relations (one-to-many), singular non-FK relations (one-to-one parent side), and singular FK relations (belongs-to)
   - Cache the result (schema doesn't change at runtime)

2. **`createEntities()`**: Create records in the database
   - Look up the ORM model delegate by camelCase model name (e.g., `orm.user` for `User`)
   - If `batch: true`: use bulk insert API. Return empty array.
   - If `batch: false`: create individually, collect and return all created records.
   - Wrap in a transaction for atomicity.

3. **`teardown()`**: Delete everything from a test run
   - Use `topoSort` and `findDeferrableEdge` from the SDK
   - Handle mixed FK casing (the same scope field may be spelled differently across models)
   - Delete by scope field for scoped models, by record IDs for non-scoped models
   - Delete the scope root last

## Server Adapter

Implemented by: `@autonoma/server-web`, `@autonoma/server-express`, `@autonoma/server-node`

A server adapter converts between a framework's request/response types and the SDK's internal `HandlerRequest`/`HandlerResponse`.

```typescript
// The adapter is a factory function that takes HandlerConfig and returns a framework-specific handler.

// Web standard (Next.js, Hono, Bun, Deno):
function createHandler(config: HandlerConfig): (req: Request) => Promise<Response>

// Express:
function createExpressHandler(config: HandlerConfig): (req: ExpressReq, res: ExpressRes) => Promise<void>

// Node http:
function createNodeHandler(config: HandlerConfig): (req: IncomingMessage, res: ServerResponse) => Promise<void>
```

Each adapter must:
1. Extract the raw request body as a string (for HMAC verification — the body must not be parsed first)
2. Extract headers as a `Record<string, string>` (lowercase keys)
3. Call `handleRequest(config, { body, headers })`
4. Write the response status and JSON body back to the framework's response object

A server adapter is typically ~15 lines of code.

## Auth Adapter (future)

Not yet implemented. Will follow the same pattern:

```typescript
interface AuthAdapter {
  /** Create auth credentials for a test user */
  authenticate(user: Record<string, unknown>): Promise<AuthCredentials>
}

interface AuthCredentials {
  token?: string                        // Bearer token
  cookies?: Array<{                     // Session cookies
    name: string
    value: string
    httpOnly?: boolean
    sameSite?: string
    path?: string
  }>
  headers?: Record<string, string>      // Custom auth headers
  credentials?: {                       // Email/password for mobile
    email: string
    password: string
  }
}
```

Planned implementations: `@autonoma/auth-betterauth`, `@autonoma/auth-workos`, `@autonoma/auth-auth0`

Until auth adapters exist, customers implement the `auth` callback directly in their handler config.
