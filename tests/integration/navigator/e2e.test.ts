/**
 * Navigator E2E — three scenarios (empty, standard, large) against real Postgres.
 * Uses testcontainers. All scenarios use nested `create` format.
 */

import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { PrismaClient } from './generated/index.js'
import { prismaAdapter } from '../../../packages/sdk-prisma/src/index'
import { handleRequest, signBody } from '../../../packages/sdk/src/index'
import type { HandlerConfig, ScenarioDefinition } from '../../../packages/sdk/src/types'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SHARED_SECRET = 'e2e-shared'
const SIGNING_SECRET = 'e2e-signing'
const SCHEMA_PATH = join(__dirname, 'prisma/schema.prisma')

// ── Scenarios ─────────────────────────────────────────────────────────────

const scenarios: Record<string, ScenarioDefinition> = {
  empty: {
    create: {
      Organization: [{
        name: 'Fresh Start Inc [{{testRunId}}]',
        users: [{ name: 'New User', email: 'new-user-{{testRunId}}@freshstart.com' }],
      }],
    },
  },

  standard: {
    create: {
      Organization: [{
        name: 'Acme Testing Co [{{testRunId}}]',
        users: [{ name: 'QA Admin', email: 'qa-admin-{{testRunId}}@acme-testing.com' }],
        Application: [
          {
            name: 'Marketing Website',
            applicationType: 'web',
            applicationMetadata: {},
            applicationVersions: [
              { name: 'v2.1', tag: 'main', path: 'https://acme.com' },
              { name: 'v2.0', tag: 'staging', path: 'https://staging.acme.com' },
            ],
          },
          {
            name: 'Android Shopping App',
            applicationType: 'android',
            applicationMetadata: {},
            applicationVersions: [
              { name: 'v3.0.1', tag: 'main', path: 'app.apk' },
            ],
          },
          {
            name: 'iOS Banking App',
            applicationType: 'ios',
            applicationMetadata: {},
            applicationVersions: [
              { name: 'v4.2', tag: 'main', path: 'app.ipa' },
            ],
          },
        ],
        folders: [
          { name: 'Smoke Tests', folderRunType: 'parallel' },
          { name: 'Regression Suite', folderRunType: 'sequential' },
          { name: 'Mobile Flows', folderRunType: 'parallel' },
          { name: 'Checkout Flows', folderRunType: 'sequential' },
          { name: 'Authentication', folderRunType: 'parallel' },
          { name: 'Nightly Batch', folderRunType: 'parallel' },
          { name: 'Critical Path', folderRunType: 'parallel' },
        ],
        Tag: [
          { name: 'P0 - Critical', description: 'Critical priority', color: '#DC2626' },
          { name: 'P1 - High', description: 'High priority', color: '#F97316' },
          { name: 'P2 - Medium', description: 'Medium priority', color: '#3B82F6' },
          { name: 'Flaky', description: 'Flaky tests', color: '#EAB308' },
          { name: 'Needs Review', description: 'Pending review', color: '#8B5CF6' },
        ],
        testGroups: {
          _count: 17,
          name: 'Test Group {{index1}}',
          architecture: "{{cycle(['web','web','web','web','web','web','android','android','android','android','android','ios','ios','ios','android','web','web'])}}",
        },
        runs: { _count: 58, _batch: true, name: 'Run {{index1}}', status: "{{cycle(['passed','passed','passed','passed','passed','failed','failed','failed','running','pending','stopped','skipped'])}}" },
        scripts: [
          { name: 'Clear Browser Cache', type: 'curl', script: 'curl -X POST http://localhost/clear' },
          { name: 'Reset API State', type: 'fetch', script: 'fetch("http://localhost/reset")' },
        ],
        variables: [
          { key: 'BASE_URL', value: 'https://www.acme-marketing.com' },
          { key: 'API_TOKEN', value: 'sk-test-abc123' },
          { key: 'TEST_EMAIL', value: 'qa-user@acme-testing.com' },
        ],
        Webhook: [
          { name: 'Slack Notifications', url: 'https://hooks.slack.com/services/acme/testing' },
          { name: 'CI Pipeline Callback', url: 'https://ci.acme-testing.com/webhooks' },
        ],
      }],
    },
  },

  large: {
    create: {
      Organization: [{
        name: 'Enterprise Scale Corp [{{testRunId}}]',
        users: { _count: 8, name: 'User {{index1}}', email: 'user-{{index1}}-{{testRunId}}@enterprise.com' },
        Application: {
          _count: 8,
          name: 'App {{index1}}',
          applicationType: "{{cycle(['web','web','web','android','android','android','ios','ios'])}}",
          applicationMetadata: {},
        },
        folders: { _count: 40, name: 'Folder {{index1}}', folderRunType: "{{cycle(['parallel','sequential'])}}" },
        Tag: { _count: 12, name: "{{cycle(['P0','P1','P2','P3','staging','production','payments','auth','search','onboarding','mobile','accessibility'])}}", description: 'Tag {{index1}}', color: "{{cycle(['#DC2626','#F97316','#3B82F6','#10B981','#6366F1','#EC4899','#F59E0B','#8B5CF6','#06B6D4','#84CC16','#14B8A6','#A855F7'])}}" },
        testGroups: { _count: 120, _batch: true, name: 'Test Group {{index1}}', architecture: "{{cycle(['web','web','web','web','android','android','android','ios','ios','ios'])}}" },
        scripts: { _count: 8, name: 'Script {{index1}}', type: "{{cycle(['curl','fetch'])}}", script: 'echo script-{{index1}}' },
        variables: { _count: 15, key: 'VAR_{{index1}}', value: 'value-{{index1}}' },
        Webhook: { _count: 5, name: 'Webhook {{index1}}', url: 'https://hooks.example.com/wh-{{index1}}' },
        runs: { _count: 10000, _batch: true, name: 'Run {{index1}}', status: "{{cycle(['passed','passed','passed','passed','passed','failed','failed','running','pending','stopped'])}}" },
      }],
    },
  },
}

// ── Runner ────────────────────────────────────────────────────────────────

function signedRequest(body: Record<string, unknown>) {
  const raw = JSON.stringify(body)
  return { body: raw, headers: { 'x-signature': signBody(raw, SHARED_SECRET) } }
}

async function runScenario(
  name: string,
  scenario: ScenarioDefinition,
  config: HandlerConfig,
  prisma: PrismaClient,
) {
  console.log(`\n──── Scenario: ${name} ────`)

  const t0 = performance.now()
  const upReq = signedRequest({ action: 'up', create: scenario.create })
  const upRes = await handleRequest(config, upReq)
  const upMs = (performance.now() - t0).toFixed(0)

  if (upRes.status !== 200) {
    console.error(`  ✗ UP failed:`, JSON.stringify(upRes.body, null, 2))
    return false
  }

  const body = upRes.body as any
  const refSummary = Object.entries(body.refs as Record<string, any[]>)
    .map(([m, r]) => `${m}:${r.length}`)
    .join(', ')
  console.log(`  ✓ UP in ${upMs}ms — ${refSummary}`)

  const orgCount = await prisma.organization.count()
  const userCount = await prisma.user.count()
  const appCount = await prisma.application.count()
  const runCount = await prisma.run.count()
  console.log(`  DB: ${orgCount} orgs, ${userCount} users, ${appCount} apps, ${runCount} runs`)

  const t1 = performance.now()
  const downReq = signedRequest({ action: 'down', refsToken: body.refsToken })
  const downRes = await handleRequest(config, downReq)
  const downMs = (performance.now() - t1).toFixed(0)

  if (downRes.status !== 200) {
    console.error(`  ✗ DOWN failed:`, JSON.stringify(downRes.body, null, 2))
    return false
  }

  const remaining = await prisma.organization.count()
  console.log(`  ✓ DOWN in ${downMs}ms — ${remaining} orgs remaining`)

  if (remaining !== 0) {
    console.error(`  ✗ Teardown incomplete!`)
    return false
  }

  return true
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════')
  console.log(' Autonoma SDK — Navigator E2E (3 scenarios)')
  console.log('═══════════════════════════════════════════════════════')

  console.log('\nStarting Postgres via testcontainers...')
  const container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const url = container.getConnectionUri()
  console.log(`  Running at: ${url}`)

  console.log('Pushing navigator schema...')
  execSync(`npx prisma db push --schema ${SCHEMA_PATH} --skip-generate --accept-data-loss`, {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  })
  console.log('  Schema pushed')

  const prisma = new PrismaClient({ datasourceUrl: url })
  const adapter = prismaAdapter(prisma, { scopeField: 'organizationID' })

  const schema = adapter.getSchema()
  console.log(`\n  Schema: ${schema.models.length} models, ${schema.edges.length} edges, ${schema.relations.length} relations`)

  const config: HandlerConfig = {
    adapter,
    sharedSecret: SHARED_SECRET,
    signingSecret: SIGNING_SECRET,
    auth: async (user: any) => ({ token: `token-${user.id}`, userId: user.id }),
  }

  let allPassed = true

  for (const [name, scenario] of Object.entries(scenarios)) {
    const passed = await runScenario(name, scenario, config, prisma)
    if (!passed) allPassed = false
  }

  await prisma.$disconnect()
  await container.stop()

  console.log('\n═══════════════════════════════════════════════════════')
  if (allPassed) {
    console.log(' ✓ ALL 3 SCENARIOS PASSED')
  } else {
    console.log(' ✗ SOME SCENARIOS FAILED')
    process.exit(1)
  }
  console.log('═══════════════════════════════════════════════════════\n')
}

main().catch((err) => {
  console.error('\nFATAL:', err)
  process.exit(1)
})
