import type { HandlerConfig, ScenarioDefinition } from './types'
import { handleRequest } from './handler'
import { signBody } from './hmac'
import { readError, readString } from './json'

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
 * Dry-run a scenario through the same handler the platform hits. Runs `up`
 * then `down` by name, and returns structured errors if either fails. No
 * HTTP server required.
 */
export async function checkScenario(
  scenario: ScenarioDefinition,
  options?: {
    testRunId?: string
    sharedSecret?: string
    signingSecret?: string
  },
): Promise<CheckResult> {
  const sharedSecret = options?.sharedSecret ?? 'autonoma-check-shared'
  const signingSecret = options?.signingSecret ?? 'autonoma-check-signing'
  const testRunId = options?.testRunId ?? `check-${scenario.name}`

  const config: HandlerConfig = {
    sharedSecret,
    signingSecret,
    scenarios: [scenario],
  }

  const upBody = JSON.stringify({
    action: 'up',
    scenario: { name: scenario.name },
    testRunId,
  })
  const upReq = {
    body: upBody,
    headers: { 'x-signature': signBody(upBody, sharedSecret) },
  }

  const t0 = performance.now()
  const upRes = await handleRequest(config, upReq)
  const upMs = Math.round(performance.now() - t0)

  if (upRes.status !== 200) {
    const errorMsg = readError(upRes.body)
    return {
      valid: false,
      phase: 'up',
      errors: [{ phase: 'up', message: errorMsg }],
      timing: { upMs, downMs: 0 },
    }
  }

  const teardownToken = readString(upRes.body, 'teardownToken')
  const downBody = JSON.stringify({
    action: 'down',
    teardownToken,
  })
  const downReq = {
    body: downBody,
    headers: { 'x-signature': signBody(downBody, sharedSecret) },
  }

  const t1 = performance.now()
  const downRes = await handleRequest(config, downReq)
  const downMs = Math.round(performance.now() - t1)

  if (downRes.status !== 200) {
    const errorMsg = readError(downRes.body)
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
  scenarios: ScenarioDefinition[],
  options?: Parameters<typeof checkScenario>[1],
): Promise<CheckResult[]> {
  // Run serially on purpose: each check performs a real up/down against a dev
  // DB or API, so bounded, deterministic load is preferable to the parallelism
  // `Promise.all` would allow. The checks are independent if that ever changes.
  const results: CheckResult[] = []
  for (const scenario of scenarios) {
    results.push(await checkScenario(scenario, options))
  }
  return results
}
