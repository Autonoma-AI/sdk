import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execSync } from 'node:child_process'

const __dirname = new URL('.', import.meta.url).pathname

interface Case {
  description: string
  input?: Record<string, unknown>
  input_pair?: [Record<string, unknown>, Record<string, unknown>]
  assert: Record<string, unknown>
}

interface FunctionDef {
  name: string
  cases: Case[]
}

interface ModuleDef {
  module: string
  functions: FunctionDef[]
}

interface BridgeConfig {
  command: string
  args: string[]
  cwd: string
}

interface RunnerConfig {
  version: number
  modules: string[]
  bridges: Record<string, BridgeConfig>
}

function callBridge(bridge: BridgeConfig, input: Record<string, unknown>): { ok: boolean; result?: unknown; error?: string } {
  const cwd = resolve(__dirname, bridge.cwd)
  const cmd = [bridge.command, ...bridge.args].join(' ')
  try {
    const stdout = execSync(cmd, {
      cwd,
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return JSON.parse(stdout.trim())
  } catch (err: any) {
    return { ok: false, error: `Bridge execution failed: ${err.message}` }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  const keysA = Object.keys(a as Record<string, unknown>).sort()
  const keysB = Object.keys(b as Record<string, unknown>).sort()
  if (keysA.length !== keysB.length || keysA.some((k, i) => k !== keysB[i])) return false
  return keysA.every(k => deepEqual((a as any)[k], (b as any)[k]))
}

function checkAssert(assert: Record<string, unknown>, result: unknown, result2?: unknown): string[] {
  const errors: string[] = []

  if ('equals' in assert) {
    if (JSON.stringify(result) !== JSON.stringify(assert.equals)) {
      errors.push(`Expected ${JSON.stringify(assert.equals)}, got ${JSON.stringify(result)}`)
    }
  }

  if ('deep_equals' in assert) {
    if (!deepEqual(result, assert.deep_equals)) {
      errors.push(`Expected ${JSON.stringify(assert.deep_equals)}, got ${JSON.stringify(result)}`)
    }
  }

  if ('type' in assert) {
    const actualType = typeof result
    if (actualType !== assert.type) {
      errors.push(`Expected type ${assert.type}, got ${actualType}`)
    }
  }

  if ('matches_regex' in assert) {
    const re = new RegExp(assert.matches_regex as string)
    if (typeof result !== 'string' || !re.test(result)) {
      errors.push(`Expected to match ${assert.matches_regex}, got ${JSON.stringify(result)}`)
    }
  }

  if ('not_null' in assert && assert.not_null === true) {
    if (result === null || result === undefined) {
      errors.push('Expected non-null result')
    }
  }

  if ('is_null' in assert && assert.is_null === true) {
    if (result !== null && result !== undefined) {
      errors.push(`Expected null, got ${JSON.stringify(result)}`)
    }
  }

  if ('throws' in assert && assert.throws === true) {
    // handled at call site
  }

  if ('parts_count' in assert) {
    if (typeof result !== 'string') {
      errors.push(`Expected string for parts_count check, got ${typeof result}`)
    } else {
      const parts = result.split('.')
      if (parts.length !== assert.parts_count) {
        errors.push(`Expected ${assert.parts_count} parts, got ${parts.length}`)
      }
    }
  }

  if ('one_of' in assert) {
    const options = assert.one_of as unknown[]
    if (!options.some(o => JSON.stringify(o) === JSON.stringify(result))) {
      errors.push(`Expected one of ${JSON.stringify(options)}, got ${JSON.stringify(result)}`)
    }
  }

  if ('gte' in assert && typeof result === 'number') {
    if (result < (assert.gte as number)) {
      errors.push(`Expected >= ${assert.gte}, got ${result}`)
    }
  }

  if ('lte' in assert && typeof result === 'number') {
    if (result > (assert.lte as number)) {
      errors.push(`Expected <= ${assert.lte}, got ${result}`)
    }
  }

  if ('pair_equals' in assert && result2 !== undefined) {
    const same = JSON.stringify(result) === JSON.stringify(result2)
    if (assert.pair_equals === true && !same) {
      errors.push(`Expected pair to be equal: ${JSON.stringify(result)} vs ${JSON.stringify(result2)}`)
    }
    if (assert.pair_equals === false && same) {
      errors.push(`Expected pair to differ but both are ${JSON.stringify(result)}`)
    }
  }

  if ('first_equals' in assert) {
    if (JSON.stringify(result) !== JSON.stringify(assert.first_equals)) {
      errors.push(`Expected first value ${JSON.stringify(assert.first_equals)}, got ${JSON.stringify(result)}`)
    }
  }

  if ('property' in assert && result !== null && typeof result === 'object') {
    const props = assert.property as Record<string, unknown>
    for (const [key, expected] of Object.entries(props)) {
      const actual = (result as Record<string, unknown>)[key]
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        errors.push(`Expected property ${key} = ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
      }
    }
  }

  // Graph-specific assertions
  const r = result as Record<string, unknown>
  if ('sorted' in assert && typeof assert.sorted === 'object' && assert.sorted !== null) {
    const sortedAssert = assert.sorted as Record<string, unknown>
    const sorted = r?.sorted as string[] | undefined
    if (!sorted) {
      errors.push('Missing sorted field in result')
    } else {
      if ('length' in sortedAssert && sorted.length !== sortedAssert.length) {
        errors.push(`Expected sorted length ${sortedAssert.length}, got ${sorted.length}`)
      }
      if ('equals' in sortedAssert) {
        if (JSON.stringify(sorted) !== JSON.stringify(sortedAssert.equals)) {
          errors.push(`Expected sorted ${JSON.stringify(sortedAssert.equals)}, got ${JSON.stringify(sorted)}`)
        }
      }
      if ('before' in sortedAssert) {
        for (const [a, b] of sortedAssert.before as [string, string][]) {
          const ia = sorted.indexOf(a)
          const ib = sorted.indexOf(b)
          if (ia === -1 || ib === -1 || ia >= ib) {
            errors.push(`Expected ${a} before ${b} in sorted: ${JSON.stringify(sorted)}`)
          }
        }
      }
      if ('contains' in sortedAssert) {
        if (!sorted.includes(sortedAssert.contains as string)) {
          errors.push(`Expected sorted to contain ${sortedAssert.contains}: ${JSON.stringify(sorted)}`)
        }
      }
      if ('contains_all' in sortedAssert) {
        for (const item of sortedAssert.contains_all as string[]) {
          if (!sorted.includes(item)) {
            errors.push(`Expected sorted to contain ${item}: ${JSON.stringify(sorted)}`)
          }
        }
      }
    }
  }

  if ('cycles' in assert && typeof assert.cycles === 'object' && assert.cycles !== null) {
    const cyclesAssert = assert.cycles as Record<string, unknown>
    const cycles = r?.cycles as string[][] | undefined
    if (!cycles) {
      errors.push('Missing cycles field in result')
    } else {
      if ('equals' in cyclesAssert) {
        if (JSON.stringify(cycles) !== JSON.stringify(cyclesAssert.equals)) {
          errors.push(`Expected cycles ${JSON.stringify(cyclesAssert.equals)}, got ${JSON.stringify(cycles)}`)
        }
      }
      if ('length' in cyclesAssert && cycles.length !== cyclesAssert.length) {
        errors.push(`Expected ${cyclesAssert.length} cycle(s), got ${cycles.length}`)
      }
    }
  }

  if ('cycles_flat_contains' in assert) {
    const cycles = r?.cycles as string[][] | undefined
    const flat = cycles?.flat() ?? []
    for (const item of assert.cycles_flat_contains as string[]) {
      if (!flat.includes(item)) {
        errors.push(`Expected cycles to contain ${item}: ${JSON.stringify(cycles)}`)
      }
    }
  }

  return errors
}

function main() {
  const config: RunnerConfig = JSON.parse(readFileSync(join(__dirname, 'runner.config.json'), 'utf-8'))

  const languages = process.argv.slice(2)
  const bridgesToRun = languages.length > 0
    ? Object.fromEntries(languages.map(l => [l, config.bridges[l]]).filter(([, v]) => v))
    : config.bridges

  let totalPassed = 0
  let totalFailed = 0
  let totalSkipped = 0

  for (const [lang, bridge] of Object.entries(bridgesToRun)) {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`  ${lang.toUpperCase()}`)
    console.log(`${'='.repeat(60)}`)

    for (const moduleName of config.modules) {
      const casesPath = join(__dirname, moduleName, 'cases.json')
      let moduleDef: ModuleDef
      try {
        moduleDef = JSON.parse(readFileSync(casesPath, 'utf-8'))
      } catch {
        console.log(`  [SKIP] ${moduleName} — no cases.json found`)
        totalSkipped++
        continue
      }

      for (const fn of moduleDef.functions) {
        console.log(`\n  ${moduleName}.${fn.name}:`)

        for (const testCase of fn.cases) {
          if (testCase.input_pair) {
            // Pair test — call bridge twice
            const res1 = callBridge(bridge, { module: moduleName, function: fn.name, input: testCase.input_pair[0] })
            const res2 = callBridge(bridge, { module: moduleName, function: fn.name, input: testCase.input_pair[1] })

            if (!res1.ok || !res2.ok) {
              console.log(`    FAIL  ${testCase.description}`)
              console.log(`          Bridge error: ${res1.error || res2.error}`)
              totalFailed++
              continue
            }

            const errors = checkAssert(testCase.assert, res1.result, res2.result)
            if (errors.length === 0) {
              console.log(`    PASS  ${testCase.description}`)
              totalPassed++
            } else {
              console.log(`    FAIL  ${testCase.description}`)
              errors.forEach(e => console.log(`          ${e}`))
              totalFailed++
            }
          } else {
            // Single test
            const res = callBridge(bridge, { module: moduleName, function: fn.name, input: testCase.input })

            if (testCase.assert.throws === true) {
              if (res.ok) {
                console.log(`    FAIL  ${testCase.description}`)
                console.log(`          Expected error but got: ${JSON.stringify(res.result)}`)
                totalFailed++
              } else {
                console.log(`    PASS  ${testCase.description}`)
                totalPassed++
              }
              continue
            }

            if (!res.ok) {
              console.log(`    FAIL  ${testCase.description}`)
              console.log(`          Bridge error: ${res.error}`)
              totalFailed++
              continue
            }

            const errors = checkAssert(testCase.assert, res.result)
            if (errors.length === 0) {
              console.log(`    PASS  ${testCase.description}`)
              totalPassed++
            } else {
              console.log(`    FAIL  ${testCase.description}`)
              errors.forEach(e => console.log(`          ${e}`))
              totalFailed++
            }
          }
        }
      }
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`  TOTAL: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`)
  console.log(`${'='.repeat(60)}\n`)

  process.exit(totalFailed > 0 ? 1 : 0)
}

main()
