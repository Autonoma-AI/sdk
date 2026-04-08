/**
 * Bulk creation test: 10k runs against quarita schema on real Postgres via testcontainers.
 */

import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { PrismaClient } from './generated/index.js'
import { prismaAdapter } from '../../../packages/sdk-prisma/src/index'
import { handleRequest, signBody } from '../../../packages/sdk/src/index'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SHARED_SECRET = 'test-shared'
const SIGNING_SECRET = 'test-signing'
const SCHEMA_PATH = join(__dirname, 'prisma/schema.prisma')

function signedRequest(body: Record<string, unknown>) {
  const raw = JSON.stringify(body)
  return { body: raw, headers: { 'x-signature': signBody(raw, SHARED_SECRET) } }
}

async function main() {
  // ── 1. Start Postgres via testcontainers ─────────────────────────────
  console.log('Starting Postgres via testcontainers...')
  const container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const url = container.getConnectionUri()
  console.log(`  Postgres running at: ${url}`)

  // ── 2. Push schema ───────────────────────────────────────────────────
  console.log('Pushing Prisma schema...')
  execSync(`npx prisma db push --schema ${SCHEMA_PATH} --skip-generate --accept-data-loss`, {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  })
  console.log('  Schema pushed')

  // ── 3. Connect Prisma + adapter ──────────────────────────────────────
  const prisma = new PrismaClient({ datasourceUrl: url })
  const adapter = prismaAdapter(prisma, { scopeField: 'organizationId' })

  const scenario = {
    name: 'bulk-test',
    description: '1 org, 1 user, 1 app, 10k test generations',
    entities: {
      Organization: {
        count: 1,
        fields: {
          name: 'Bulk Test Org [{{testRunId}}]',
          slug: 'bulk-{{testRunId}}',
        },
      },
      User: {
        count: 1,
        fields: {
          name: 'Admin',
          email: 'admin-{{testRunId}}@test.com',
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
          name: 'Web App',
          organizationId: '{{refs.Organization[0].id}}',
          architecture: 'WEB',
        },
      },
      TestPlan: {
        count: 1,
        fields: {
          name: 'Load Test Plan',
          plan: 'Stress test',
          userId: '{{refs.User[0].id}}',
          organizationId: '{{refs.Organization[0].id}}',
          applicationId: '{{refs.Application[0].id}}',
        },
      },
      TestGeneration: {
        count: 10000,
        batch: true,
        fields: {
          testPlanId: '{{refs.TestPlan[0].id}}',
          applicationId: '{{refs.Application[0].id}}',
          status: '{{cycle(["pending","running","success","failed"])}}',
          conversation: '[]',
        },
      },
    },
  }

  const config = {
    adapter,
    sharedSecret: SHARED_SECRET,
    signingSecret: SIGNING_SECRET,
    scenarios: { scenarios: [scenario] },
    auth: async (user: any) => ({ headers: { Authorization: `Bearer token-${user?.id ?? 'anon'}` } }),
  }

  // ── 4. Run UP ────────────────────────────────────────────────────────
  console.log('\nRunning UP (creating 1 org + 1 user + 1 app + 1 plan + 10,000 test generations)...')
  const t0 = performance.now()

  const req = signedRequest({
    action: 'up',
    environment: 'bulk-test',
  })
  const res = await handleRequest(config, req)

  const elapsed = ((performance.now() - t0) / 1000).toFixed(2)

  if (res.status !== 200) {
    console.error('UP failed:', JSON.stringify(res.body, null, 2))
    await cleanup(prisma, container)
    process.exit(1)
  }

  const body = res.body as any
  console.log(`  ✓ UP succeeded in ${elapsed}s`)
  for (const [model, records] of Object.entries(body.refs) as any) {
    console.log(`    ${model}: ${records.length} record(s)`)
  }

  // ── 5. Verify counts in DB ───────────────────────────────────────────
  console.log('\nVerifying counts in Postgres...')
  const orgCount = await prisma.organization.count()
  const userCount = await prisma.user.count()
  const genCount = await prisma.testGeneration.count()
  console.log(`  Organizations: ${orgCount}`)
  console.log(`  Users: ${userCount}`)
  console.log(`  TestGenerations: ${genCount}`)

  if (genCount !== 10000) {
    console.error(`  ✗ Expected 10,000 TestGenerations, got ${genCount}`)
  } else {
    console.log(`  ✓ 10,000 TestGenerations confirmed`)
  }

  // Check status distribution
  const statusCounts = await prisma.testGeneration.groupBy({
    by: ['status'],
    _count: true,
  })
  console.log('  Status distribution:')
  for (const s of statusCounts) {
    console.log(`    ${s.status}: ${s._count}`)
  }

  // ── 6. Run DOWN ──────────────────────────────────────────────────────
  console.log('\nRunning DOWN (teardown)...')
  const t1 = performance.now()

  const downReq = signedRequest({ action: 'down', refsToken: body.refsToken })
  const downRes = await handleRequest(config, downReq)

  const downElapsed = ((performance.now() - t1) / 1000).toFixed(2)

  if (downRes.status !== 200) {
    console.error('DOWN failed:', JSON.stringify(downRes.body, null, 2))
  } else {
    console.log(`  ✓ DOWN succeeded in ${downElapsed}s`)
  }

  // Verify clean
  const remaining = await prisma.testGeneration.count()
  console.log(`  TestGenerations remaining: ${remaining}`)

  await cleanup(prisma, container)

  console.log('\n═══════════════════════════════════════════════')
  console.log(` ✓ DONE — 10k records created in ${elapsed}s, torn down in ${downElapsed}s`)
  console.log('═══════════════════════════════════════════════\n')
}

async function cleanup(prisma: PrismaClient, container: any) {
  await prisma.$disconnect()
  await container.stop()
}

main().catch(async (err) => {
  console.error('\nFATAL:', err)
  process.exit(1)
})
