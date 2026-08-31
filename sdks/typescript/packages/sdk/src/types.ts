/**
 * Public types for the Autonoma SDK (Scenario v2).
 *
 * A customer authors named **scenarios** with `defineScenario`. The
 * platform calls `up` with only a scenario name + `testRunId`; the
 * scenario's `up` runs free-form async code and returns optional
 * `auth`/`teardown`. The SDK owns the envelope: `teardownToken` signing,
 * expiry defaults, and the protocol `version` field.
 *
 * `defineFactory` and the factory types below survive as an optional
 * library a scenario's `up`/`down` may use internally (see `factory.ts`);
 * they are no longer wired to the wire protocol.
 */
import type { ZodTypeAny, z } from 'zod'

/** A JSON scalar leaf value. */
export type JsonScalar = string | number | boolean | null

/** Arbitrary JSON with scalar leaves. */
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue }

/**
 * Whatever a scenario's `up` returns as `teardown`. Carried inside the
 * signed `teardownToken` at `up` and handed back to the scenario's `down`
 * verbatim, so a scenario can carry the handles it needs to tear itself down.
 */
export type ScenarioTeardown = Record<string, unknown>

export interface SdkInfo {
  language: string
  orm: string
  server: string
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

/** Credentials the test runner uses to act as the seeded user. */
export interface AuthResult {
  cookies?: AuthCookie[]
  headers?: Record<string, string>
  credentials?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Scenario authoring surface
// ---------------------------------------------------------------------------

/** Context passed to a scenario's `up`. */
export interface ScenarioUpContext {
  /** Unique id for this test run — seed uniqueness helpers from it. */
  testRunId: string
}

/** What a scenario's `up` returns. All fields optional. */
export interface ScenarioUpResult {
  auth?: AuthResult
  teardown?: ScenarioTeardown
}

/** Context passed to a scenario's `down`. */
export interface ScenarioDownContext {
  /** The scenario name, recovered from the verified teardown token. */
  name: string
  /** The `teardown` handle this scenario returned from `up`. */
  teardown: ScenarioTeardown
  /** The `testRunId` captured at `up` time. */
  testRunId: string
}

/**
 * A named scenario. `up` provisions the environment a test needs; the
 * optional `down` tears it back down. Register with
 * `createHandler({ ..., scenarios: [defineScenario({...})] })`.
 */
export interface ScenarioDefinition {
  /** Stable identifier the platform calls `up`/`down` by. */
  name: string
  /** Human-readable summary shown in `discover`. */
  description: string
  up: (ctx: ScenarioUpContext) => Promise<ScenarioUpResult> | ScenarioUpResult
  down?: (ctx: ScenarioDownContext) => Promise<void> | void
}

// ---------------------------------------------------------------------------
// Optional factory library (not wired to the wire protocol in v2)
// ---------------------------------------------------------------------------

export interface FactoryContext {
  /** All refs created so far, keyed by model name. */
  refs: Record<string, Record<string, unknown>[]>
  /** Logical scope value or testRunId fallback. */
  scenarioName: string
  /** Unique ID for this test run. */
  testRunId: string
}

/**
 * Factory definition — an optional helper a scenario's `up`/`down` may use
 * to create/tear down entities through the app's real logic. The two type
 * parameters bind to the Zod schemas you pass in.
 */
export interface FactoryDefinition<
  TInput extends ZodTypeAny = ZodTypeAny,
  TRef extends ZodTypeAny | undefined = undefined,
> {
  create: (
    data: z.infer<TInput>,
    ctx: FactoryContext,
  ) => Promise<RefRecord<TRef>> | RefRecord<TRef>
  teardown?: (
    record: TRef extends ZodTypeAny
      ? z.infer<TRef>
      : Record<string, unknown> & { id: string | number },
    ctx: FactoryContext,
  ) => Promise<void> | void
  /** Zod schema for the create input. */
  inputSchema: TInput
  /** Optional Zod schema for the record returned by `create`. */
  refSchema?: TRef
}

type RefRecord<TRef extends ZodTypeAny | undefined> = TRef extends ZodTypeAny
  ? z.input<TRef>
  : Record<string, unknown> & { id: string | number }

// `FactoryDefinition` is invariant in its type parameters, so the registry
// accepts any concrete factory.
export type FactoryRegistry = Record<string, FactoryDefinition<any, any>>

// ---------------------------------------------------------------------------
// Handler config + wire types
// ---------------------------------------------------------------------------

export interface HandlerConfig {
  /** Shared secret — known by both you and Autonoma. Verifies HMAC signatures. */
  sharedSecret: string
  /** Private signing secret — only you know this. Signs the teardown token. */
  signingSecret: string
  /** Registered scenarios. Every scenario the platform can run must be listed. */
  scenarios?: ScenarioDefinition[]
  /**
   * Token/environment lifetime returned on `up` as `expiresInSeconds`.
   * Defaults to one hour when omitted.
   */
  expiresInSeconds?: number
  /**
   * @deprecated Ignored - the endpoint is always enabled; HMAC signing is the
   * gate. Gate it in your handler if you want it dark in your own production.
   */
  allowProduction?: boolean
  /** SDK identity metadata. Server adapters populate this. */
  sdk?: Partial<SdkInfo>
}

export interface HandlerRequest {
  body: string
  headers: Record<string, string>
}

export interface HandlerResponse {
  status: number
  body: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Response shapes (v2)
// ---------------------------------------------------------------------------

export interface ScenarioDescriptor {
  name: string
  description: string
}

export type DiscoverResponse = {
  scenarios: ScenarioDescriptor[]
  version: string
  sdk: SdkInfo
}

export type UpResponse = {
  auth?: AuthResult
  teardownToken: string
  expiresInSeconds?: number
  version: string
  sdk: SdkInfo
}

export type DownResponse = {
  ok?: boolean
  version: string
  sdk: SdkInfo
}
