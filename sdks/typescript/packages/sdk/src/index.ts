// Public API
export { handleRequest, PROTOCOL_VERSION, resolveTokens } from './handler'
export { signBody, verifySignature } from './hmac'
export { signRefs, verifyRefs } from './refs'
export { fingerprint } from './fingerprint'
export { topoSort, findDeferrableEdge } from './graph'
export { resolvePayloadTree, computeTeardownOrder } from './payload-topo'
export {
  buildSchemaFromFactories,
  fieldTypeFromZod,
  schemaToWire,
} from './schema'
export { checkScenario, checkAllScenarios } from './check'
export { defineFactory } from './factory'
export { AutonomaError, Errors } from './errors'

// Types
export type {
  SchemaInfo,
  ModelInfo,
  FieldInfo,
  FKEdge,
  HandlerConfig,
  HandlerRequest,
  HandlerResponse,
  AuthContext,
  AuthCookie,
  AuthResult,
  DiscoverResponse,
  UpResponse,
  DownResponse,
  SchemaRelation,
  SdkInfo,
  HookContext,
  FactoryContext,
  FactoryDefinition,
  FactoryRegistry,
} from './types'

export type { CheckResult, CheckError, CheckScenario } from './check'
export type { CreateOp, ResolvedTree } from './payload-topo'
export type { RefsPayload } from './refs'
