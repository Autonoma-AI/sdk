// Public API
export { handleRequest, PROTOCOL_VERSION } from './handler'
export { signBody, verifySignature } from './hmac'
export { signRefs, verifyRefs } from './refs'
export { fingerprint } from './fingerprint'
export { resolveTemplate } from './template'
export { topoSort, findDeferrableEdge } from './graph'
export { resolveTree } from './tree'
export { checkScenario, checkAllScenarios } from './check'
export { introspectDatabase } from './introspect'
export { getDialect } from './dialect'

// Types
export type {
  SQLExecutor,
  SchemaInfo,
  ModelInfo,
  FieldInfo,
  FKEdge,
  ResolvedEntitySpec,
  CreateContext,
  ScenarioDefinition,
  HandlerConfig,
  HandlerRequest,
  HandlerResponse,
  AuthResult,
  DiscoverResponse,
  UpResponse,
  DownResponse,
  SchemaRelation,
  SdkInfo,
} from './types'

export type { Dialect } from './dialect'
export type { IntrospectionResult } from './introspect'
export type { TemplateContext } from './template'
export type { CreateOp, ResolvedTree, RefNode } from './tree'
export type { CheckResult, CheckError } from './check'
