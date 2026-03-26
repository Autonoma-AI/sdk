/** ORM adapter interface — implemented by @autonoma-ai/sdk-prisma, @autonoma-ai/sdk-drizzle, etc. */
export interface OrmAdapter {
  /** Return schema metadata for discover (models, fields, relationships) */
  getSchema(): SchemaInfo

  /** Create entities from a resolved spec, return created records keyed by model */
  createEntities(
    spec: Record<string, ResolvedEntitySpec>,
    context: CreateContext,
  ): Promise<Record<string, Record<string, unknown>[]>>

  /** Delete all data scoped to a value. Refs are provided for targeted cleanup of un-scoped models. */
  teardown(scopeValue: string, refs?: Record<string, Record<string, unknown>[]>): Promise<void>

  /**
   * Update a single record by ID. Used to backfill nullable FKs in circular
   * dependency cycles (e.g. Application.mainBranchId after Branch is created).
   * Optional — only required when circular FK relationships exist in the schema.
   */
  updateEntity?(model: string, id: string, fields: Record<string, unknown>): Promise<void>
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

export interface HandlerConfig {
  adapter: OrmAdapter
  /** Shared secret — known by both you and Autonoma. Used to verify HMAC signatures on incoming requests. */
  sharedSecret: string
  /** Internal secret — only you know this. Used to sign the refs JWT token. Autonoma never sees it. */
  signingSecret: string
  allowProduction?: boolean
  auth?: (user: Record<string, unknown>) => Promise<AuthResult> | AuthResult
}

export interface AuthResult {
  token: string
  [key: string]: unknown
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
