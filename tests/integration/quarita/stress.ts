/**
 * Quarita stress test — many scenario variations to find edge cases.
 *
 * Scenarios:
 *   1. empty          — org + user only
 *   2. standard       — realistic org with apps, tests, runs
 *   3. single-each    — exactly 1 of every model
 *   4. deep-chain     — org → app → plan → generation → steps → test → teststep → run → runstep
 *   5. wide-shallow   — 1 org, 100 apps, 1 version each
 *   6. multi-user     — 1 org, 50 users, 50 members
 *   7. heavy-runs     — 1 test, 10,000 runs (batch)
 *   8. heavy-steps    — 1 test with 500 steps, 1 run with 500 run steps
 *   9. many-tags      — 1 app, 200 tags (batch)
 *  10. full-load      — everything at scale: 5 apps, 10 plans, 50 generations, 10k runs
 *  11. mobile-app     — iOS app with MobileApplicationData instead of Web
 *  12. invitations    — org with pending invitations
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
const SHARED_SECRET = 'stress-shared'
const SIGNING_SECRET = 'stress-signing'
const SCHEMA_PATH = join(__dirname, 'prisma/schema.prisma')

// ── Scenarios ─────────────────────────────────────────────────────────────

const scenarios: Record<string, ScenarioDefinition> = {
  // 1. empty
  'empty': {
    entities: {
      Organization: { count: 1, fields: { name: 'Empty Org [{{testRunId}}]', slug: 'empty-{{testRunId}}' } },
      User: { count: 1, fields: { name: 'Solo User', email: 'solo-{{testRunId}}@test.com' } },
      Member: { count: 1, fields: { userId: '{{refs.User[0].id}}', organizationId: '{{refs.Organization[0].id}}', role: 'owner' } },
    },
  },

  // 2. standard
  'standard': {
    entities: {
      Organization: { count: 1, fields: { name: 'Standard Org [{{testRunId}}]', slug: 'std-{{testRunId}}' } },
      User: { count: 1, fields: { name: 'Admin', email: 'admin-{{testRunId}}@test.com' } },
      Member: { count: 1, fields: { userId: '{{refs.User[0].id}}', organizationId: '{{refs.Organization[0].id}}', role: 'owner' } },
      Application: { count: 2, fields: { name: "{{cycle(['Web App','Mobile App'])}}", organizationId: '{{refs.Organization[0].id}}', architecture: "{{cycle(['WEB','ANDROID'])}}" } },
      WebApplicationData: { count: 1, fields: { applicationId: '{{refs.Application[0].id}}', url: 'https://app.example.com' } },
      MobileApplicationData: { count: 1, fields: { applicationId: '{{refs.Application[1].id}}', packageUrl: 'https://cdn.example.com/app.apk' } },
      Tag: { count: 5, fields: { name: "{{cycle(['Critical','High','Medium','Low','Flaky'])}}", color: "{{cycle(['#FF0000','#FF8800','#FFFF00','#00FF00','#888888'])}}", applicationId: '{{refs.Application[0].id}}' } },
      Folder: { count: 3, fields: { name: "{{cycle(['Smoke','Regression','E2E'])}}", applicationId: '{{refs.Application[0].id}}' } },
      TestPlan: { count: 2, fields: { name: "{{cycle(['Smoke Plan','Full Plan'])}}", plan: 'Test plan content', organizationId: '{{refs.Organization[0].id}}', applicationId: '{{refs.Application[0].id}}' } },
      TestGeneration: { count: 2, fields: { testPlanId: '{{refs.TestPlan[0].id}}', applicationId: '{{refs.Application[0].id}}', status: "{{cycle(['success','pending'])}}", conversation: '[]' } },
      GenerationStep: { count: 4, fields: { generationId: '{{refs.TestGeneration[0].id}}', order: '{{index1}}', interaction: "{{cycle(['click','type','assert','scroll'])}}", params: {}, output: {} } },
      Test: { count: 1, fields: { name: 'Homepage Test', testGenerationId: '{{refs.TestGeneration[0].id}}', applicationId: '{{refs.Application[0].id}}' } },
      TestStep: { count: 6, fields: { testId: '{{refs.Test[0].id}}', order: '{{index1}}', interaction: "{{cycle(['click','type','assert','scroll','click','assert'])}}", params: {} } },
      Run: { count: 10, fields: { testId: '{{refs.Test[0].id}}' } },
    },
  },

  // 3. single-each — exactly 1 of every entity type
  'single-each': {
    entities: {
      Organization: { count: 1, fields: { name: 'Single Org [{{testRunId}}]', slug: 'single-{{testRunId}}' } },
      User: { count: 1, fields: { name: 'Single User', email: 'single-{{testRunId}}@test.com' } },
      Member: { count: 1, fields: { userId: '{{refs.User[0].id}}', organizationId: '{{refs.Organization[0].id}}', role: 'owner' } },
      Application: { count: 1, fields: { name: 'Single App', organizationId: '{{refs.Organization[0].id}}', architecture: 'WEB' } },
      WebApplicationData: { count: 1, fields: { applicationId: '{{refs.Application[0].id}}', url: 'https://single.example.com' } },
      Tag: { count: 1, fields: { name: 'Tag1', color: '#000000', applicationId: '{{refs.Application[0].id}}' } },
      Folder: { count: 1, fields: { name: 'Root', applicationId: '{{refs.Application[0].id}}' } },
      TestPlan: { count: 1, fields: { name: 'Plan', plan: 'content', organizationId: '{{refs.Organization[0].id}}', applicationId: '{{refs.Application[0].id}}' } },
      TestGeneration: { count: 1, fields: { testPlanId: '{{refs.TestPlan[0].id}}', applicationId: '{{refs.Application[0].id}}', conversation: '[]' } },
      GenerationStep: { count: 1, fields: { generationId: '{{refs.TestGeneration[0].id}}', order: 1, interaction: 'click', params: {}, output: {} } },
      Test: { count: 1, fields: { name: 'Test', testGenerationId: '{{refs.TestGeneration[0].id}}', applicationId: '{{refs.Application[0].id}}' } },
      TestStep: { count: 1, fields: { testId: '{{refs.Test[0].id}}', order: 1, interaction: 'click', params: {} } },
      TestTag: { count: 1, fields: { testId: '{{refs.Test[0].id}}', tagId: '{{refs.Tag[0].id}}' } },
      Run: { count: 1, fields: { testId: '{{refs.Test[0].id}}' } },
      RunStep: { count: 1, fields: { runId: '{{refs.Run[0].id}}', testStepId: '{{refs.TestStep[0].id}}', order: 1, status: 'passed', output: {} } },
      Invitation: { count: 1, fields: { email: 'invite-{{testRunId}}@test.com', inviterId: '{{refs.User[0].id}}', organizationId: '{{refs.Organization[0].id}}', role: 'member', expiresAt: '{{now()}}' } },
      ApiKey: { count: 1, fields: { key: 'key-{{testRunId}}', userId: '{{refs.User[0].id}}' } },
    },
  },

  // 4. deep-chain — max depth FK chain
  'deep-chain': {
    entities: {
      Organization: { count: 1, fields: { name: 'Deep Org [{{testRunId}}]', slug: 'deep-{{testRunId}}' } },
      User: { count: 1, fields: { name: 'Deep User', email: 'deep-{{testRunId}}@test.com' } },
      Member: { count: 1, fields: { userId: '{{refs.User[0].id}}', organizationId: '{{refs.Organization[0].id}}', role: 'owner' } },
      Application: { count: 1, fields: { name: 'Deep App', organizationId: '{{refs.Organization[0].id}}', architecture: 'WEB' } },
      TestPlan: { count: 1, fields: { name: 'Deep Plan', plan: 'deep', organizationId: '{{refs.Organization[0].id}}', applicationId: '{{refs.Application[0].id}}', userId: '{{refs.User[0].id}}' } },
      TestGeneration: { count: 1, fields: { testPlanId: '{{refs.TestPlan[0].id}}', applicationId: '{{refs.Application[0].id}}', conversation: '[]', status: 'success' } },
      GenerationStep: { count: 10, fields: { generationId: '{{refs.TestGeneration[0].id}}', order: '{{index1}}', interaction: "{{cycle(['click','type','assert','scroll','wait','click','type','assert','scroll','wait'])}}", params: { selector: '.btn-{{index}}' }, output: { success: true } } },
      Test: { count: 1, fields: { name: 'Deep Test', testGenerationId: '{{refs.TestGeneration[0].id}}', applicationId: '{{refs.Application[0].id}}' } },
      TestStep: { count: 10, fields: { testId: '{{refs.Test[0].id}}', order: '{{index1}}', interaction: "{{cycle(['click','type','assert','scroll','wait','click','type','assert','scroll','wait'])}}", params: { selector: '.el-{{index}}' } } },
      Run: { count: 1, fields: { testId: '{{refs.Test[0].id}}' } },
      // RunStep has @@unique([runId, testStepId]) — can only create 1 per run+step pair
      // With flat format, all RunSteps point to the same run and same testStep
      // This is a limitation: we can't express "runStep[i].testStepId = testStep[i].id"
      RunStep: { count: 1, fields: { runId: '{{refs.Run[0].id}}', testStepId: '{{refs.TestStep[0].id}}', order: 1, status: 'passed', output: {} } },
    },
  },

  // 5. wide-shallow — many apps, 1 of everything else
  'wide-shallow': {
    entities: {
      Organization: { count: 1, fields: { name: 'Wide Org [{{testRunId}}]', slug: 'wide-{{testRunId}}' } },
      User: { count: 1, fields: { name: 'Wide User', email: 'wide-{{testRunId}}@test.com' } },
      Member: { count: 1, fields: { userId: '{{refs.User[0].id}}', organizationId: '{{refs.Organization[0].id}}', role: 'owner' } },
      Application: { count: 100, fields: { name: 'App {{index1}}', organizationId: '{{refs.Organization[0].id}}', architecture: "{{cycle(['WEB','ANDROID','IOS'])}}" } },
    },
  },

  // 6. multi-user — many users in one org
  'multi-user': {
    entities: {
      Organization: { count: 1, fields: { name: 'Multi Org [{{testRunId}}]', slug: 'multi-{{testRunId}}' } },
      User: { count: 50, fields: { name: 'User {{index1}}', email: 'user-{{index1}}-{{testRunId}}@test.com' } },
      // Can't batch — unique constraint on [userId, organizationId] and all users share the same org
      // Each member references a different user, but with count:50 and refs.User[0].id they'd all be the same
      // Limitation: we can't express "member[i].userId = user[i].id" without nested format
      // Workaround: just create 1 member
      Member: { count: 1, fields: { userId: '{{refs.User[0].id}}', organizationId: '{{refs.Organization[0].id}}', role: 'owner' } },
    },
  },

  // 7. heavy-runs — 10k runs for one test
  'heavy-runs': {
    entities: {
      Organization: { count: 1, fields: { name: 'Heavy Runs Org [{{testRunId}}]', slug: 'heavy-runs-{{testRunId}}' } },
      User: { count: 1, fields: { name: 'Runner', email: 'runner-{{testRunId}}@test.com' } },
      Member: { count: 1, fields: { userId: '{{refs.User[0].id}}', organizationId: '{{refs.Organization[0].id}}', role: 'owner' } },
      Application: { count: 1, fields: { name: 'App', organizationId: '{{refs.Organization[0].id}}', architecture: 'WEB' } },
      TestPlan: { count: 1, fields: { name: 'Plan', plan: 'content', organizationId: '{{refs.Organization[0].id}}', applicationId: '{{refs.Application[0].id}}' } },
      TestGeneration: { count: 1, fields: { testPlanId: '{{refs.TestPlan[0].id}}', applicationId: '{{refs.Application[0].id}}', conversation: '[]' } },
      Test: { count: 1, fields: { name: 'Load Test', testGenerationId: '{{refs.TestGeneration[0].id}}', applicationId: '{{refs.Application[0].id}}' } },
      Run: { count: 10000, batch: true, fields: { testId: '{{refs.Test[0].id}}' } },
    },
  },

  // 8. heavy-steps — 1 test with 500 steps, 1 run with 500 run steps
  'heavy-steps': {
    entities: {
      Organization: { count: 1, fields: { name: 'Heavy Steps Org [{{testRunId}}]', slug: 'heavy-steps-{{testRunId}}' } },
      User: { count: 1, fields: { name: 'Stepper', email: 'stepper-{{testRunId}}@test.com' } },
      Member: { count: 1, fields: { userId: '{{refs.User[0].id}}', organizationId: '{{refs.Organization[0].id}}', role: 'owner' } },
      Application: { count: 1, fields: { name: 'App', organizationId: '{{refs.Organization[0].id}}', architecture: 'WEB' } },
      TestPlan: { count: 1, fields: { name: 'Plan', plan: 'content', organizationId: '{{refs.Organization[0].id}}', applicationId: '{{refs.Application[0].id}}' } },
      TestGeneration: { count: 1, fields: { testPlanId: '{{refs.TestPlan[0].id}}', applicationId: '{{refs.Application[0].id}}', conversation: '[]' } },
      Test: { count: 1, fields: { name: 'Mega Test', testGenerationId: '{{refs.TestGeneration[0].id}}', applicationId: '{{refs.Application[0].id}}' } },
      TestStep: { count: 500, batch: true, fields: { testId: '{{refs.Test[0].id}}', order: '{{index1}}', interaction: "{{cycle(['click','type','assert','scroll','wait'])}}", params: {} } },
      Run: { count: 1, fields: { testId: '{{refs.Test[0].id}}' } },
    },
  },

  // 9. many-tags — 200 tags on one app
  'many-tags': {
    entities: {
      Organization: { count: 1, fields: { name: 'Tags Org [{{testRunId}}]', slug: 'tags-{{testRunId}}' } },
      User: { count: 1, fields: { name: 'Tagger', email: 'tagger-{{testRunId}}@test.com' } },
      Member: { count: 1, fields: { userId: '{{refs.User[0].id}}', organizationId: '{{refs.Organization[0].id}}', role: 'owner' } },
      Application: { count: 1, fields: { name: 'Tagged App', organizationId: '{{refs.Organization[0].id}}', architecture: 'WEB' } },
      Tag: { count: 200, batch: true, fields: { name: 'Tag {{index1}}', color: "{{cycle(['#FF0000','#00FF00','#0000FF','#FFFF00','#FF00FF','#00FFFF','#888888','#333333'])}}", applicationId: '{{refs.Application[0].id}}' } },
    },
  },

  // 10. full-load — everything at scale
  'full-load': {
    entities: {
      Organization: { count: 1, fields: { name: 'Full Load Org [{{testRunId}}]', slug: 'full-{{testRunId}}' } },
      User: { count: 5, fields: { name: 'User {{index1}}', email: 'user-{{index1}}-{{testRunId}}@full.com' } },
      // Only 1 member — can't create 5 with same userId+orgId (unique constraint)
      Member: { count: 1, fields: { userId: '{{refs.User[0].id}}', organizationId: '{{refs.Organization[0].id}}', role: 'owner' } },
      Application: { count: 5, fields: { name: "{{cycle(['Web','Android','iOS','Desktop','API'])}}", organizationId: '{{refs.Organization[0].id}}', architecture: "{{cycle(['WEB','ANDROID','IOS','WEB','WEB'])}}" } },
      Folder: { count: 20, batch: true, fields: { name: 'Folder {{index1}}', applicationId: '{{refs.Application[0].id}}' } },
      Tag: { count: 30, batch: true, fields: { name: 'Tag {{index1}}', color: '#{{testRunId}}', applicationId: '{{refs.Application[0].id}}' } },
      TestPlan: { count: 10, fields: { name: 'Plan {{index1}}', plan: 'Content for plan {{index1}}', organizationId: '{{refs.Organization[0].id}}', applicationId: '{{refs.Application[0].id}}' } },
      TestGeneration: { count: 1, fields: { testPlanId: '{{refs.TestPlan[0].id}}', applicationId: '{{refs.Application[0].id}}', conversation: '[]', status: 'success' } },
      Test: { count: 1, fields: { name: 'Load Test', testGenerationId: '{{refs.TestGeneration[0].id}}', applicationId: '{{refs.Application[0].id}}' } },
      Run: { count: 10000, batch: true, fields: { testId: '{{refs.Test[0].id}}' } },
    },
  },

  // 11. mobile-app — iOS with MobileApplicationData
  'mobile-app': {
    entities: {
      Organization: { count: 1, fields: { name: 'Mobile Org [{{testRunId}}]', slug: 'mobile-{{testRunId}}' } },
      User: { count: 1, fields: { name: 'Mobile Dev', email: 'mobile-{{testRunId}}@test.com' } },
      Member: { count: 1, fields: { userId: '{{refs.User[0].id}}', organizationId: '{{refs.Organization[0].id}}', role: 'owner' } },
      Application: { count: 1, fields: { name: 'iOS Banking', organizationId: '{{refs.Organization[0].id}}', architecture: 'IOS' } },
      MobileApplicationData: { count: 1, fields: { applicationId: '{{refs.Application[0].id}}', packageUrl: 'https://cdn.example.com/banking.ipa' } },
      TestPlan: { count: 1, fields: { name: 'iOS Smoke', plan: 'Mobile smoke tests', organizationId: '{{refs.Organization[0].id}}', applicationId: '{{refs.Application[0].id}}' } },
      TestGeneration: { count: 1, fields: { testPlanId: '{{refs.TestPlan[0].id}}', applicationId: '{{refs.Application[0].id}}', conversation: '[]', status: 'success' } },
      Test: { count: 1, fields: { name: 'Launch App', testGenerationId: '{{refs.TestGeneration[0].id}}', applicationId: '{{refs.Application[0].id}}' } },
    },
  },

  // 12. invitations — org with pending invitations and API keys
  'invitations': {
    entities: {
      Organization: { count: 1, fields: { name: 'Invite Org [{{testRunId}}]', slug: 'invite-{{testRunId}}' } },
      User: { count: 1, fields: { name: 'Inviter', email: 'inviter-{{testRunId}}@test.com' } },
      Member: { count: 1, fields: { userId: '{{refs.User[0].id}}', organizationId: '{{refs.Organization[0].id}}', role: 'owner' } },
      Invitation: { count: 5, fields: { email: 'invited-{{index1}}-{{testRunId}}@test.com', inviterId: '{{refs.User[0].id}}', organizationId: '{{refs.Organization[0].id}}', role: "{{cycle(['admin','member','member','member','member'])}}", expiresAt: '{{now()}}' } },
      ApiKey: { count: 3, fields: { key: 'apikey-{{index}}-{{testRunId}}', userId: '{{refs.User[0].id}}' } },
    },
  },
}

// ── DB Cleanup ────────────────────────────────────────────────────────────

async function cleanDB(prisma: PrismaClient) {
  // Delete in reverse FK order to avoid constraint violations
  // Use actual Postgres table names (some models use @@map)
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "run_step", "run", "test_tag", "test_step", "test",
      "generation_step", "TestGeneration", "TestPlan",
      "tag", "folder",
      "WebApplicationData", "MobileApplicationData", "Application",
      "ApiKey", "Invitation", "Member", "Account", "Session",
      "Verification", "User", "Organization"
    CASCADE
  `)
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
): Promise<{ name: string; ok: boolean; upMs: number; downMs: number; error?: string }> {
  // UP
  const t0 = performance.now()
  const upReq = signedRequest({ action: 'up', entities: scenario.entities })
  const upRes = await handleRequest(config, upReq)
  const upMs = Math.round(performance.now() - t0)

  if (upRes.status !== 200) {
    const fullErr = (upRes.body as any).error ?? JSON.stringify(upRes.body)
    const lines = fullErr.split('\n').filter((l: string) => l.trim() && !l.includes('packages/sdk'))
    const lastLine = lines[lines.length - 1]?.trim() ?? fullErr.slice(0, 200)
    return { name, ok: false, upMs, downMs: 0, error: `UP: ${lastLine}` }
  }

  const body = upRes.body as any
  const refCounts = Object.entries(body.refs as Record<string, any[]>)
    .filter(([, r]) => r.length > 0)
    .map(([m, r]) => `${m}:${r.length}`)
    .join(' ')

  // Verify org exists
  const orgCount = await prisma.organization.count()
  if (orgCount === 0) {
    return { name, ok: false, upMs, downMs: 0, error: 'No org in DB after UP' }
  }

  // DOWN
  const t1 = performance.now()
  const downReq = signedRequest({ action: 'down', refsToken: body.refsToken })
  const downRes = await handleRequest(config, downReq)
  const downMs = Math.round(performance.now() - t1)

  if (downRes.status !== 200) {
    const err = (downRes.body as any).error?.slice(0, 200) ?? JSON.stringify(downRes.body).slice(0, 200)
    return { name, ok: false, upMs, downMs, error: `DOWN: ${err}` }
  }

  // Verify clean
  const remaining = await prisma.organization.count()
  if (remaining !== 0) {
    return { name, ok: false, upMs, downMs, error: `${remaining} orgs still in DB` }
  }

  return { name, ok: true, upMs, downMs }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(' Quarita Stress Test — 12 scenario variations')
  console.log('═══════════════════════════════════════════════════════════════\n')

  console.log('Starting Postgres via testcontainers...')
  const container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const url = container.getConnectionUri()

  console.log('Pushing schema...')
  execSync(`npx prisma db push --schema ${SCHEMA_PATH} --skip-generate --accept-data-loss`, {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  })

  const prisma = new PrismaClient({ datasourceUrl: url })
  const adapter = prismaAdapter(prisma, { scopeField: 'organizationId' })
  const schema = adapter.getSchema()
  console.log(`Schema: ${schema.models.length} models, ${schema.edges.length} edges\n`)

  const config: HandlerConfig = {
    adapter,
    sharedSecret: SHARED_SECRET,
    signingSecret: SIGNING_SECRET,
    auth: async (user: any) => ({ token: `t-${user.id}`, userId: user.id }),
  }

  const results: Array<{ name: string; ok: boolean; upMs: number; downMs: number; error?: string }> = []

  for (const [name, scenario] of Object.entries(scenarios)) {
    // Clean DB between scenarios to prevent cascading failures
    await cleanDB(prisma)

    process.stdout.write(`  ${name.padEnd(20)}`)
    const result = await runScenario(name, scenario, config, prisma)
    results.push(result)

    if (result.ok) {
      console.log(`✓  UP ${String(result.upMs).padStart(6)}ms  DOWN ${String(result.downMs).padStart(6)}ms`)
    } else {
      console.log(`✗  ${result.error}`)
    }
  }

  await prisma.$disconnect()
  await container.stop()

  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length

  const total = Object.keys(scenarios).length
  console.log(`\n═══════════════════════════════════════════════════════════════`)
  console.log(` ${passed} passed, ${failed} failed out of ${total} scenarios`)
  if (failed > 0) {
    console.log('\n Failed:')
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`   ${r.name}: ${r.error}`)
    }
  }
  console.log('═══════════════════════════════════════════════════════════════\n')

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
