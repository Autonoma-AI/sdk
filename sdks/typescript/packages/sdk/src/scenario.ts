/**
 * Define a named scenario.
 *
 * A scenario's `up` is free-form async code (loops, conditionals, real
 * API calls) that provisions an isolated environment and returns the
 * `auth`/`teardown` a test run needs. An omitted `down` is a no-op. Register
 * scenarios with `createHandler({ ..., scenarios: [defineScenario({...})] })`.
 *
 * @example
 * ```ts
 * defineScenario({
 *   name: 'single-user',
 *   description: 'One verified user in a fresh org',
 *   up: async ({ testRunId }) => {
 *     const email = uniqueEmail(testRunId)
 *     const user = await db.user.create({ email })
 *     return {
 *       auth: { headers: { Authorization: `Bearer ${await mintToken(user)}` } },
 *       teardown: { userId: user.id },
 *     }
 *   },
 *   down: async ({ teardown }) => {
 *     await db.user.delete({ id: teardown.userId })
 *   },
 * })
 * ```
 */
import type { ScenarioDefinition } from './types'

export function defineScenario(definition: ScenarioDefinition): ScenarioDefinition {
  if (typeof definition.name !== 'string' || definition.name.length === 0) {
    throw new Error('Scenario "name" must be a non-empty string')
  }
  if (typeof definition.description !== 'string') {
    throw new Error('Scenario "description" must be a string')
  }
  if (typeof definition.up !== 'function') {
    throw new Error('Scenario "up" must be a function')
  }
  if (definition.down !== undefined && typeof definition.down !== 'function') {
    throw new Error('Scenario "down" must be a function if provided')
  }
  return definition
}
