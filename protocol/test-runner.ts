#!/usr/bin/env node
/**
 * Language-agnostic protocol test runner for Autonoma Environment Factory.
 *
 * Usage:
 *   npx tsx tests/protocol/test-runner.ts --url http://localhost:3000/api/autonoma --secret <secret>
 *
 * Runs all test suites in tests/protocol/suites/ against the given endpoint.
 * Works with any language's SDK implementation.
 */

import { createHmac } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface TestStep {
  action: string
  description?: string
  body?: Record<string, unknown>
  overrideSignature?: string
  expect: {
    status: number
    body?: Record<string, unknown>
    bodyShape?: Record<string, string>
    bodyAssertions?: Array<{
      path: string
      type?: string
      pattern?: string
      notEmpty?: boolean
    }>
  }
  saveAs?: string
}

interface TestSuite {
  name: string
  steps: TestStep[]
}

// Parse CLI args
const args = process.argv.slice(2)
const urlIndex = args.indexOf('--url')
const secretIndex = args.indexOf('--secret')

if (urlIndex === -1 || secretIndex === -1) {
  console.error('Usage: test-runner --url <endpoint> --secret <shared-secret>')
  process.exit(1)
}

const baseUrl = args[urlIndex + 1]!
const secret = args[secretIndex + 1]!

function sign(body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

function getByPath(obj: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function resolveTemplates(
  value: unknown,
  saved: Record<string, unknown>,
): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+(?:\.\w+(?:\[\d+\])?)*)?\}\}/g, (_, path: string) => {
      const resolved = getByPath(saved, path)
      return String(resolved ?? '')
    })
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, saved))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveTemplates(v, saved)
    }
    return result
  }
  return value
}

async function sendRequest(
  action: string,
  body: Record<string, unknown> = {},
  overrideSignature?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify({ action, ...body })
  const signature = overrideSignature ?? sign(payload)

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-signature': signature,
    },
    body: payload,
  })

  const responseBody = await response.json()
  return { status: response.status, body: responseBody as Record<string, unknown> }
}

async function runSuite(suite: TestSuite): Promise<{ passed: number; failed: number; errors: string[] }> {
  const saved: Record<string, unknown> = {}
  let passed = 0
  let failed = 0
  const errors: string[] = []

  for (let i = 0; i < suite.steps.length; i++) {
    const step = suite.steps[i]!
    const stepDesc = step.description ?? `step ${i}: ${step.action}`

    try {
      // Resolve templates in body
      const body = step.body
        ? (resolveTemplates(step.body, saved) as Record<string, unknown>)
        : {}

      const result = await sendRequest(step.action, body, step.overrideSignature)

      // Check status
      if (result.status !== step.expect.status) {
        errors.push(
          `  [${stepDesc}] Expected status ${step.expect.status}, got ${result.status}`,
        )
        failed++
        continue
      }

      // Check exact body match
      if (step.expect.body) {
        for (const [key, expected] of Object.entries(step.expect.body)) {
          const actual = result.body[key]
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            errors.push(
              `  [${stepDesc}] body.${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
            )
            failed++
            continue
          }
        }
      }

      // Check body shape
      if (step.expect.bodyShape) {
        for (const [key, expectedType] of Object.entries(step.expect.bodyShape)) {
          const actual = result.body[key]
          const actualType = Array.isArray(actual) ? 'array' : typeof actual
          if (actualType !== expectedType) {
            errors.push(
              `  [${stepDesc}] body.${key} type: expected ${expectedType}, got ${actualType}`,
            )
            failed++
            continue
          }
        }
      }

      // Check assertions
      if (step.expect.bodyAssertions) {
        for (const assertion of step.expect.bodyAssertions) {
          const value = getByPath(result.body, assertion.path)
          if (assertion.type && typeof value !== assertion.type) {
            errors.push(
              `  [${stepDesc}] ${assertion.path}: expected type ${assertion.type}, got ${typeof value}`,
            )
          }
          if (assertion.pattern && typeof value === 'string' && !new RegExp(assertion.pattern).test(value)) {
            errors.push(
              `  [${stepDesc}] ${assertion.path}: '${value}' doesn't match /${assertion.pattern}/`,
            )
          }
          if (assertion.notEmpty && (!value || (typeof value === 'string' && value.length === 0))) {
            errors.push(`  [${stepDesc}] ${assertion.path}: expected non-empty`)
          }
        }
      }

      // Save result
      if (step.saveAs) {
        saved[step.saveAs] = result.body
      }

      if (errors.length === failed) passed++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`  [${stepDesc}] Error: ${msg}`)
      failed++
    }
  }

  return { passed, failed, errors }
}

async function main() {
  console.log(`\nAutonoma Protocol Test Runner`)
  console.log(`Target: ${baseUrl}\n`)

  const suitesDir = join(__dirname, 'suites')
  const files = await readdir(suitesDir)
  const suiteFiles = files.filter((f) => f.endsWith('.test.json'))

  let totalPassed = 0
  let totalFailed = 0

  for (const file of suiteFiles) {
    const content = await readFile(join(suitesDir, file), 'utf-8')
    const suite: TestSuite = JSON.parse(content)

    process.stdout.write(`  ${suite.name} ... `)
    const result = await runSuite(suite)

    if (result.failed === 0) {
      console.log(`PASS (${result.passed} steps)`)
    } else {
      console.log(`FAIL`)
      for (const err of result.errors) console.log(err)
    }

    totalPassed += result.passed
    totalFailed += result.failed
  }

  console.log(`\n${totalPassed} passed, ${totalFailed} failed\n`)
  process.exit(totalFailed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
