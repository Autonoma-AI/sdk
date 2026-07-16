/**
 * Public types for the Autonoma SDK.
 *
 * The SDK is now factory-driven: every model the dashboard can create
 * comes from a registered factory, and each factory carries a Zod input
 * schema (and optional ref schema). There is no SQL introspection, no
 * SQL fallback, and no executor on `HandlerConfig`. Factories that need
 * DB access use whatever client the host already has.
 */
import type { ZodTypeAny, z } from 'zod'

export interface SchemaInfo {
  models: ModelInfo[]
  /** Always emitted as `[]` in factory-driven mode; kept for wire-shape symmetry. */
  edges: FKEdge[]
  /** Always emitted as `[]` in factory-driven mode; kept for wire-shape symmetry. */
  relations: SchemaRelation[]
  scopeField: string
}

/** Wire-shape relic — emitted as an empty array in factory-driven mode. */
export interface SchemaRelation {
  parentModel: string
  childModel: string
  parentField: string
  childField: string
}

export interface ModelInfo {
  name: string
  /** Cosmetic — snake_case of `name`; the dashboard renders it for display only. */
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

/** Wire-shape relic — emitted as an empty array in factory-driven mode. */
export interface FKEdge {
  from: string
  to: string
  localField: string
  foreignField: string
  nullable: boolean
}

export interface SdkInfo {
  language: string
  orm: string
  server: string
}

export interface FactoryContext {
  /** All refs created so far, keyed by model name */
  refs: Record<string, Record<string, unknown>[]>
  /** Logical scope value or testRunId fallback (kept for backwards-compat). */
  scenarioName: string
  /** Unique ID for this test run */
  testRunId: string
}

/**
 * Factory definition.
 *
 * The two type parameters are bound to the Zod schemas you pass in:
 *   - `TInput extends ZodTypeAny` — the create input. `data` arrives
 *     already validated and typed as `z.infer<TInput>`, so your factory
 *     body doesn't need a manual `z.infer<...>` annotation.
 *   - `TRef extends ZodTypeAny` — the shape your `create` returns and
 *     `teardown` later receives. When `refSchema` is omitted, `TRef`
 *     widens to a generic `{ id; ... }` record so old factories keep
 *     compiling without a refSchema.
 *
 * Bind both at the call site by writing `defineFactory({...})` — TS
 * infers the generics from the schema instances.
 */
export interface FactoryDefinition<
  TInput extends ZodTypeAny = ZodTypeAny,
  TRef extends ZodTypeAny | undefined = undefined,
> {
  /**
   * Create a single entity. Receives the validated input (parsed by
   * `inputSchema`) and must return at least `{ id }`. When `refSchema`
   * is set, the return type is constrained to `z.input<TRef>` so the
   * teardown signature lines up exactly.
   */
  create: (
    data: z.infer<TInput>,
    ctx: FactoryContext,
  ) =>
    | Promise<RefRecord<TRef>>
    | RefRecord<TRef>
  /**
   * Optional teardown per record. Receives whatever `create` returned —
   * validated through `refSchema` first when one is registered. If
   * omitted the model is left alone on `down`. There is no SQL fallback.
   */
  teardown?: (
    record: TRef extends ZodTypeAny ? z.infer<TRef> : Record<string, unknown> & { id: string | number },
    ctx: FactoryContext,
  ) => Promise<void> | void
  /** Required Zod schema for the create input — drives both validation and discover. */
  inputSchema: TInput
  /** Optional Zod schema for the record returned by `create` (validated on teardown). */
  refSchema?: TRef
}

type RefRecord<TRef extends ZodTypeAny | undefined> = TRef extends ZodTypeAny
  ? z.input<TRef>
  : Record<string, unknown> & { id: string | number }

// `FactoryDefinition` is invariant in its type parameters (functions
// take the schema-derived types as inputs), so the registry must accept
// any concrete factory. The handler uses `factory.inputSchema.safeParse`
// at runtime — TypeScript can't statically know which schema sits
// behind a registry lookup, and that's fine.
export type FactoryRegistry = Record<string, FactoryDefinition<any, any>>

export interface HandlerConfig {
  /** Scope field name (camelCase), e.g., 'organizationId' */
  scopeField: string
  /** Shared secret — known by both you and Autonoma. Used to verify HMAC signatures on incoming requests. */
  sharedSecret: string
  /** Internal secret — only you know this. Used to sign the refs JWT token. Autonoma never sees it. */
  signingSecret: string
  /** Factory definitions per model. Required: every model the dashboard sends in `create` must have one. */
  factories?: FactoryRegistry
  /**
   * @deprecated Ignored - the endpoint is always enabled; HMAC signing is the
   * gate. On Autonoma preview environments (`AUTONOMA_PREVIEWKIT` is set) no
   * extra guard is needed. If you deploy the factory in your own environments
   * and want it dark in production, gate it in your handler, e.g. return 404
   * when `process.env.NODE_ENV === 'production'`.
   */
  allowProduction?: boolean
  /**
   * Auth callback — called after entity creation during `up`.
   * Receives the first User record from refs (or null if no User model exists)
   * and a context object with scopeValue and refs.
   * Must return auth credentials for the test runner.
   */
  auth: (user: Record<string, unknown> | null, context: AuthContext) => Promise<AuthResult> | AuthResult
  /**
   * Optional hook called before teardown in `down`.
   * Use this to clean up data created outside the SDK (e.g., external service records).
   */
  beforeDown?: (context: HookContext) => Promise<void> | void
  /**
   * Optional hook called after entity creation and auth in `up`.
   * Can modify the auth result before it is returned to the caller.
   */
  afterUp?: (context: HookContext, authResult: AuthResult) => Promise<AuthResult> | AuthResult
  /** SDK identity metadata. Server adapters populate this. */
  sdk?: Partial<SdkInfo>
}

export interface AuthContext {
  /** The detected scope value (e.g. organization ID) or testRunId fallback. */
  scopeValue: string
  /** All created entity refs, keyed by model name. */
  refs: Record<string, Record<string, unknown>[]>
}

export interface HookContext {
  scenarioName: string
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
