import type { FactoryRegistry, HandlerConfig } from './types'
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

export interface CheckScenario {
  /** Flat map: model name → list of entity payloads (with `_alias` / `_ref`). */
  create: Record<string, Record<string, unknown>[]>
}

/**
 * Dry-run a scenario through the same handler the dashboard hits. Runs
 * `up` then `down` and returns structured errors if either fails.
 */
export async function checkScenario(
  factories: FactoryRegistry,
  scenario: CheckScenario,
  options?: {
    scopeField?: string
    sharedSecret?: string
    signingSecret?: string
    auth?: HandlerConfig['auth']
  },
): Promise<CheckResult> {
  const sharedSecret = options?.sharedSecret ?? 'autonoma-check-shared'
  const signingSecret = options?.signingSecret ?? 'autonoma-check-signing'

  const config: HandlerConfig = {
    scopeField: options?.scopeField ?? 'organizationId',
    sharedSecret,
    signingSecret,
    allowProduction: true,
    factories,
    auth: options?.auth ?? (async () => ({ headers: { Authorization: 'Bearer check-token' } })),
  }

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
      errors: [{ phase: 'up', message: errorMsg }],
      timing: { upMs, downMs: 0 },
    }
  }

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

export async function checkAllScenarios(
  factories: FactoryRegistry,
  scenarios: CheckScenario[],
  options?: Parameters<typeof checkScenario>[2],
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const scenario of scenarios) {
    results.push(await checkScenario(factories, scenario, options))
  }
  return results
}
