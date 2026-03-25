/**
 * E2E walkthrough: quarita schema
 *
 * This script proves the full SDK flow against a real Postgres database:
 *   1. Introspect Prisma → export autonoma-schema.json
 *   2. Validate a hand-written scenario with the CLI
 *   3. Run `up` → create real records
 *   4. Verify records in the DB
 *   5. Run `down` → teardown
 *   6. Verify records are gone
 */

import { PrismaClient } from './generated/index.js'
import { prismaAdapter } from '../../../packages/sdk-prisma/src/index'
import { handleRequest, signBody } from '../../../packages/sdk/src/index'
import { writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:autonoma@localhost:5555/autonoma_test'
const SHARED_SECRET = 'test-shared-for-e2e'
const SIGNING_SECRET = 'test-signing-for-e2e'

const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL })
const adapter = prismaAdapter(prisma, { scopeField: 'organizationId' })

// ── Helpers ───────────────────────────────────────────────────────────────

function log(step: string, msg: string) {
  console.log(`\n[${ step }] ${msg}`)
}

function signedRequest(body: Record<string, unknown>) {
  const raw = JSON.stringify(body)
  return { body: raw, headers: { 'x-signature': signBody(raw, SHARED_SECRET) } }
}

// ── Step 1: Introspect & export schema ────────────────────────────────────

async function step1_exportSchema() {
  log('STEP 1', 'Introspecting Prisma schema...')

  const schema = adapter.getSchema()
  console.log(`  Models: ${schema.models.map(m => m.name).join(', ')}`)
  console.log(`  FK edges: ${schema.edges.length}`)
  console.log(`  Scope field: ${schema.scopeField}`)

  const schemaPath = join(__dirname, 'autonoma-schema.json')
  await writeFile(schemaPath, JSON.stringify(schema, null, 2))
  console.log(`  Written to: ${schemaPath}`)

  return { schema, schemaPath }
}

// ── Step 2: Write & validate a scenario ───────────────────────────────────

async function step2_validateScenario(schemaPath: string) {
  log('STEP 2', 'Writing and validating scenario...')

  // This is what an LLM (or a human) would write for a "basic org with tests" scenario.
  // We need: Organization → User → Member → Application → WebApplicationData → TestPlan
  const scenario = {
    name: 'quarita-basic',
    description: 'Org with admin user, one web app, one test plan',
    entities: {
      Organization: {
        count: 1,
        fields: {
          name: 'Test Org [{{testRunId}}]',
          slug: 'test-org-{{testRunId}}',
        },
      },
      User: {
        count: 1,
        fields: {
          name: 'Admin User',
          email: 'admin-{{testRunId}}@autonoma.dev',
        },
      },
      Member: {
        count: 1,
        fields: {
          userId: '{{refs.User[0].id}}',
          organizationId: '{{refs.Organization[0].id}}',
          role: 'owner',
        },
      },
      Application: {
        count: 1,
        fields: {
          name: 'My Web App',
          organizationId: '{{refs.Organization[0].id}}',
          architecture: 'WEB',
        },
      },
      WebApplicationData: {
        count: 1,
        fields: {
          applicationId: '{{refs.Application[0].id}}',
          url: 'https://example.com',
        },
      },
      TestPlan: {
        count: 1,
        fields: {
          name: 'Smoke Tests',
          plan: 'Basic smoke test coverage',
          userId: '{{refs.User[0].id}}',
          organizationId: '{{refs.Organization[0].id}}',
          applicationId: '{{refs.Application[0].id}}',
        },
      },
    },
  }

  const scenarioPath = join(__dirname, 'scenario.json')
  await writeFile(scenarioPath, JSON.stringify(scenario, null, 2))

  // Validate via CLI
  const cliPath = join(__dirname, '../../../packages/sdk/dist/cli.js')
  try {
    const { stdout } = await exec('node', [cliPath, 'validate', schemaPath, scenarioPath])
    const result = JSON.parse(stdout)
    if (result.valid) {
      console.log('  ✓ Scenario is valid')
    } else {
      console.log('  ✗ Validation errors:')
      for (const err of result.errors) {
        console.log(`    ${err.path}: ${err.message}`)
        console.log(`    fix: ${err.fix}`)
      }
      process.exit(1)
    }
  } catch (err: any) {
    // exit code 1 = validation errors
    if (err.stdout) {
      const result = JSON.parse(err.stdout)
      console.log('  ✗ Validation errors:')
      for (const error of result.errors) {
        console.log(`    ${error.path}: ${error.message}`)
        console.log(`    fix: ${error.fix}`)
      }
    } else {
      console.error('  ✗ CLI error:', err.message)
    }
    process.exit(1)
  }

  return scenario
}

// ── Step 3: Run `up` ──────────────────────────────────────────────────────

async function step3_up(scenario: any) {
  log('STEP 3', 'Running `up` — creating records in Postgres...')

  const config = {
    adapter,
    sharedSecret: SHARED_SECRET,
    signingSecret: SIGNING_SECRET,
    scenarios: { scenarios: [scenario] },
    auth: async (user: any) => ({ token: `fake-jwt-for-${user.id}`, userId: user.id }),
  }

  const req = signedRequest({
    action: 'up',
    environment: 'quarita-basic',
    testRunId: `e2e-${Date.now()}`,
  })

  const res = await handleRequest(config, req)

  if (res.status !== 200) {
    console.error('  ✗ up failed:', res.body)
    process.exit(1)
  }

  const body = res.body as any
  console.log('  ✓ up succeeded')
  console.log(`  Auth token: ${body.auth.token}`)
  console.log(`  Refs created:`)
  for (const [model, records] of Object.entries(body.refs) as any) {
    console.log(`    ${model}: ${records.length} record(s)`)
  }

  return body
}

// ── Step 4: Verify records in DB ──────────────────────────────────────────

async function step4_verifyCreated(refs: Record<string, any[]>) {
  log('STEP 4', 'Verifying records exist in Postgres...')

  const org = await prisma.organization.findUnique({ where: { id: refs.Organization[0].id } })
  console.log(`  Organization: ${org ? '✓ ' + org.name : '✗ NOT FOUND'}`)

  const user = await prisma.user.findUnique({ where: { id: refs.User[0].id } })
  console.log(`  User: ${user ? '✓ ' + user.email : '✗ NOT FOUND'}`)

  const member = await prisma.member.findUnique({ where: { id: refs.Member[0].id } })
  console.log(`  Member: ${member ? '✓ role=' + member.role : '✗ NOT FOUND'}`)

  const app = await prisma.application.findUnique({ where: { id: refs.Application[0].id } })
  console.log(`  Application: ${app ? '✓ ' + app.name : '✗ NOT FOUND'}`)

  const webData = await prisma.webApplicationData.findUnique({ where: { applicationId: refs.Application[0].id } })
  console.log(`  WebApplicationData: ${webData ? '✓ ' + webData.url : '✗ NOT FOUND'}`)

  const plan = await prisma.testPlan.findUnique({ where: { id: refs.TestPlan[0].id } })
  console.log(`  TestPlan: ${plan ? '✓ ' + plan.name : '✗ NOT FOUND'}`)

  if (!org || !user || !member || !app || !webData || !plan) {
    console.error('\n  ✗ Some records missing!')
    process.exit(1)
  }
}

// ── Step 5: Run `down` ────────────────────────────────────────────────────

async function step5_down(refsToken: string) {
  log('STEP 5', 'Running `down` — tearing down all records...')

  const config = {
    adapter,
    sharedSecret: SHARED_SECRET,
    signingSecret: SIGNING_SECRET,
    scenarios: { scenarios: [] as any[] },
  }

  const req = signedRequest({ action: 'down', refsToken })
  const res = await handleRequest(config, req)

  if (res.status !== 200) {
    console.error('  ✗ down failed:', res.body)
    process.exit(1)
  }

  console.log('  ✓ down succeeded:', res.body)
}

// ── Step 6: Verify teardown ───────────────────────────────────────────────

async function step6_verifyTeardown(refs: Record<string, any[]>) {
  log('STEP 6', 'Verifying records are gone from Postgres...')

  const org = await prisma.organization.findUnique({ where: { id: refs.Organization[0].id } })
  const user = await prisma.user.findUnique({ where: { id: refs.User[0].id } })
  const member = await prisma.member.findUnique({ where: { id: refs.Member[0].id } })
  const app = await prisma.application.findUnique({ where: { id: refs.Application[0].id } })
  const plan = await prisma.testPlan.findUnique({ where: { id: refs.TestPlan[0].id } })

  const checks = { Organization: org, User: user, Member: member, Application: app, TestPlan: plan }
  const remaining = Object.entries(checks).filter(([, v]) => v !== null)
  if (remaining.length === 0) {
    console.log('  ✓ All records deleted')
  } else {
    console.error(`  ✗ ${remaining.length} records still in DB:`)
    for (const [name] of remaining) console.error(`    - ${name}`)
    process.exit(1)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════')
  console.log(' Autonoma SDK — E2E Test (quarita schema)')
  console.log('═══════════════════════════════════════════════════')

  try {
    const { schemaPath } = await step1_exportSchema()
    const scenario = await step2_validateScenario(schemaPath)
    const { refs, refsToken } = await step3_up(scenario)
    await step4_verifyCreated(refs)
    await step5_down(refsToken)
    await step6_verifyTeardown(refs)

    console.log('\n═══════════════════════════════════════════════════')
    console.log(' ✓ ALL STEPS PASSED')
    console.log('═══════════════════════════════════════════════════\n')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error('\nFATAL:', err)
  prisma.$disconnect()
  process.exit(1)
})
