import type {
  SQLExecutor,
  ScenarioDefinition,
  HandlerConfig,
} from './types'
import { handleRequest } from './handler'
import { signBody } from './hmac'

export interface CheckResult {
  valid: boolean
  phase: 'up' | 'down' | 'ok'
  errors: CheckError[]
  timing?: { upMs: number; downMs: number }
}

export interface CheckError {
  phase: 'up' | 'down'
  message: string
  fix?: string
}

/**
 * Dry-run a scenario against a real database.
 * Runs the full up → down cycle and returns structured errors.
 */
export async function checkScenario(
  executor: SQLExecutor,
  scenario: ScenarioDefinition,
  options?: {
    scopeField: string
    dialect?: HandlerConfig['dialect']
    dbSchema?: string
    tableNameMap?: Record<string, string>
    sharedSecret?: string
    signingSecret?: string
    auth?: HandlerConfig['auth']
  },
): Promise<CheckResult> {
  const sharedSecret = options?.sharedSecret ?? 'autonoma-check-shared'
  const signingSecret = options?.signingSecret ?? 'autonoma-check-signing'

  const config: HandlerConfig = {
    executor,
    scopeField: options?.scopeField ?? 'organizationId',
    dialect: options?.dialect,
    dbSchema: options?.dbSchema,
    tableNameMap: options?.tableNameMap,
    sharedSecret,
    signingSecret,
    auth: options?.auth ?? (async () => ({ headers: { Authorization: 'Bearer check-token' } })),
  }

  // Up
  const upBody = JSON.stringify({ action: 'up', create: scenario.create })
  const upReq = {
    body: upBody,
    headers: { 'x-signature': signBody(upBody, sharedSecret) },
  }

  const t0 = performance.now()
  const upRes = await handleRequest(config, upReq)
  const upMs = Math.round(performance.now() - t0)

  if (upRes.status !== 200) {
    const errorMsg = (upRes.body as Record<string, string>).error ?? 'Unknown error'
    return {
      valid: false,
      phase: 'up',
      errors: [{ phase: 'up', message: errorMsg, fix: suggestFix(errorMsg) }],
      timing: { upMs, downMs: 0 },
    }
  }

  // Down
  const refsToken = (upRes.body as Record<string, string>).refsToken
  const downBody = JSON.stringify({ action: 'down', refsToken })
  const downReq = {
    body: downBody,
    headers: { 'x-signature': signBody(downBody, sharedSecret) },
  }

  const t1 = performance.now()
  const downRes = await handleRequest(config, downReq)
  const downMs = Math.round(performance.now() - t1)

  if (downRes.status !== 200) {
    const errorMsg = (downRes.body as Record<string, string>).error ?? 'Unknown error'
    return {
      valid: false,
      phase: 'down',
      errors: [{ phase: 'down', message: errorMsg }],
      timing: { upMs, downMs },
    }
  }

  return { valid: true, phase: 'ok', errors: [], timing: { upMs, downMs } }
}

/**
 * Check multiple scenarios sequentially.
 */
export async function checkAllScenarios(
  executor: SQLExecutor,
  scenarios: ScenarioDefinition[],
  options?: {
    scopeField: string
    dialect?: HandlerConfig['dialect']
    dbSchema?: string
    tableNameMap?: Record<string, string>
    sharedSecret?: string
    signingSecret?: string
    auth?: HandlerConfig['auth']
  },
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const scenario of scenarios) {
    results.push(await checkScenario(executor, scenario, options))
  }
  return results
}

function suggestFix(errorMsg: string): string {
  if (errorMsg.includes('Unique constraint failed') || errorMsg.includes('unique constraint')) {
    const match = errorMsg.match(/fields: \(`(.+?)`\)/) ?? errorMsg.match(/constraint "(.+?)"/)
    if (match) return `Unique constraint on (${match[1]}). Add {{testRunId}} or {{index}} to make values unique.`
    return 'Unique constraint violation. Make field values unique across instances.'
  }
  if (errorMsg.includes('Foreign key constraint') || errorMsg.includes('foreign key')) {
    return 'A referenced record does not exist. Check that parent entities are nested correctly.'
  }
  if (errorMsg.includes('null value in column') || errorMsg.includes('must not be null')) {
    return 'A required field is null. Add it to the node with a value.'
  }
  return ''
}
