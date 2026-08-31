import { describe, it, expect } from 'vitest'
import { defineScenario } from '../src/scenario.js'
import { checkScenario } from '../src/check.js'

describe('defineScenario', () => {
  it('returns the definition when valid', () => {
    const s = defineScenario({ name: 'a', description: 'b', up: () => ({}) })
    expect(s.name).toBe('a')
  })

  it('rejects a missing name', () => {
    expect(() =>
      // @ts-expect-error intentionally invalid
      defineScenario({ description: 'b', up: () => ({}) }),
    ).toThrow(/name/)
  })

  it('rejects a non-function up', () => {
    expect(() =>
      // @ts-expect-error intentionally invalid
      defineScenario({ name: 'a', description: 'b', up: 'nope' }),
    ).toThrow(/up/)
  })
})

describe('checkScenario', () => {
  it('runs a full up -> down round-trip and reports ok', async () => {
    let torn = false
    const scenario = defineScenario({
      name: 'roundtrip',
      description: 'x',
      up: async ({ testRunId }) => ({
        teardown: { id: testRunId },
      }),
      down: async () => {
        torn = true
      },
    })
    const result = await checkScenario(scenario, { testRunId: 'run-1' })
    expect(result.valid).toBe(true)
    expect(result.phase).toBe('ok')
    expect(torn).toBe(true)
  })

  it('reports an up failure when the scenario throws', async () => {
    const scenario = defineScenario({
      name: 'boom',
      description: 'x',
      up: () => {
        throw new Error('kaboom')
      },
    })
    const result = await checkScenario(scenario)
    expect(result.valid).toBe(false)
    expect(result.phase).toBe('up')
    expect(result.errors[0]!.message).toContain('kaboom')
  })
})
