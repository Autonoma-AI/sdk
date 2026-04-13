/** Minimal SQL executor — wrap your DB connection (pg Pool, Prisma, Drizzle, etc.) into this. */
export interface SQLExecutor {
  /** Execute a SQL query with parameterized values. Returns rows as plain objects. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>

  /**
   * Execute a block within a transaction.
   * The callback receives an executor scoped to the transaction.
   * If the callback throws, the transaction is rolled back.
   */
  transaction<T>(fn: (tx: SQLExecutor) => Promise<T>): Promise<T>
}

export interface SchemaInfo {
  models: ModelInfo[]
  edges: FKEdge[]
  relations: SchemaRelation[]
  scopeField: string
}

/** Maps a parent's relation field name to the child model and its FK */
export interface SchemaRelation {
  parentModel: string
  childModel: string
  parentField: string
  childField: string
}

export interface ModelInfo {
  name: string
  tableName: string
  fields: FieldInfo[]
}

export interface FieldInfo {
  name: string
  type: string
  isRequired: boolean
  isId: boolean
  hasDefault: boolean
}

export interface FKEdge {
  from: string
  to: string
  localField: string
  foreignField: string
  nullable: boolean
}

export interface EntitySpec {
  count: number
  fields: Record<string, unknown>
  batch?: boolean
}

export interface ResolvedEntitySpec {
  count: number
  fields: Record<string, unknown>[]
  batch?: boolean
}

export interface CreateContext {
  testRunId: string
  refs: Record<string, Record<string, unknown>[]>
}

/** Scenario sent inline in the `up` request body */
export interface ScenarioDefinition {
  /** Nested tree: model name → array of node objects with nested children */
  create: Record<string, Record<string, unknown>[]>
}

export interface SdkInfo {
  language: string
  orm: string
  server: string
}

export interface HandlerConfig {
  /** SQL executor wrapping your database connection */
  executor: SQLExecutor
  /** Scope field name (camelCase), e.g., 'organizationId' */
  scopeField: string
  /** Database dialect. Defaults to 'postgres'. */
  dialect?: 'postgres' | 'mysql' | 'sqlite'
  /** DB schema name. Defaults to 'public' for Postgres. */
  dbSchema?: string
  /**
   * Map scenario model names to DB table names.
   * Keys are model names (PascalCase), values are DB table names.
   * If omitted, auto-detected from information_schema with PascalCase inference.
   */
  tableNameMap?: Record<string, string>
  /** Tables to exclude from introspection. Defaults to ['_prisma_migrations']. */
  excludeTables?: string[]
  /** Shared secret — known by both you and Autonoma. Used to verify HMAC signatures on incoming requests. */
  sharedSecret: string
  /** Internal secret — only you know this. Used to sign the refs JWT token. Autonoma never sees it. */
  signingSecret: string
  allowProduction?: boolean
  /**
   * Auth callback — called after entity creation during `up`.
   * Receives the first User record from refs (or null if no User model exists)
   * and a context object with scopeValue and refs.
   * Must return auth credentials for the test runner.
   */
  auth: (user: Record<string, unknown> | null, context: AuthContext) => Promise<AuthResult> | AuthResult
  /** SDK identity metadata. Server and ORM adapters populate this. */
  sdk?: Partial<SdkInfo>
}

export interface AuthContext {
  /** The detected scope value (e.g. organization ID) or testRunId fallback. */
  scopeValue: string
  /** All created entity refs, keyed by model name. */
  refs: Record<string, Record<string, unknown>[]>
}

export interface AuthCookie {
  name: string
  value: string
  httpOnly?: boolean
  sameSite?: 'strict' | 'lax' | 'none'
  path?: string
  domain?: string
  secure?: boolean
  maxAge?: number
}

export interface AuthResult {
  cookies?: AuthCookie[]
  headers?: Record<string, string>
  credentials?: Record<string, string>
}

export interface HandlerRequest {
  body: string
  headers: Record<string, string>
}

export interface HandlerResponse {
  status: number
  body: Record<string, unknown>
}

export interface DiscoverResponse {
  schema: SchemaInfo
}

export interface UpResponse {
  auth: AuthResult
  refs: Record<string, Record<string, unknown>[]>
  refsToken: string
}

export interface DownResponse {
  ok: boolean
}
