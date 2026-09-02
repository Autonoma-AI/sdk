// Public API
export { handleRequest, PROTOCOL_VERSION } from './handler'
export { signBody, verifySignature } from './hmac'
export { signRefs, verifyRefs } from './refs'
export { defineScenario } from './scenario'
export { checkScenario, checkAllScenarios } from './check'
export {
  uniqueToken,
  uniqueId,
  uniqueSlug,
  uniqueEmail,
} from './unique'
export { AutonomaError, Errors } from './errors'

// Optional factory helper (not wired to the v2 wire protocol; a scenario's
// up/down may use it internally).
export { defineFactory } from './factory'

// Types
export type {
  JsonScalar,
  JsonValue,
  ScenarioTeardown,
  ScenarioDefinition,
  ScenarioDescriptor,
  ScenarioUpContext,
  ScenarioUpResult,
  ScenarioDownContext,
  HandlerConfig,
  HandlerRequest,
  HandlerResponse,
  AuthCookie,
  AuthResult,
  DiscoverResponse,
  UpResponse,
  DownResponse,
  SdkInfo,
  FactoryContext,
  FactoryDefinition,
  FactoryRegistry,
} from './types'

export type { CheckResult, CheckError } from './check'
export type { RefsPayload } from './refs'
