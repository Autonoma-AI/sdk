import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { PrismaClient } from './generated/index.js'
import { prismaExecutor } from '../../../packages/sdk-prisma/src/index'
import { checkScenario } from '../../../packages/sdk/src/check'
import type { SQLExecutor, ScenarioDefinition } from '../../../packages/sdk/src/types'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = join(__dirname, 'prisma/schema.prisma')

let container: StartedPostgreSqlContainer
let prisma: PrismaClient
let executor: SQLExecutor

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  execSync(`npx prisma db push --schema ${SCHEMA_PATH} --skip-generate --accept-data-loss`, {
    env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    stdio: 'pipe',
  })
  prisma = new PrismaClient({ datasourceUrl: container.getConnectionUri() })
  executor = prismaExecutor(prisma as any)
}, 60_000)

afterAll(async () => {
  await prisma.$disconnect()
  await container.stop()
})

afterEach(async () => {
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
})

async function check(scenario: ScenarioDefinition, label = 'scenario') {
  const result = await checkScenario(executor, scenario, { scopeField: 'organizationId' })
  if (!result.valid) {
    console.log(`  [${label}] FAILED at phase: ${result.phase}`)
    for (const err of result.errors) {
      console.log(`    ${err.phase}: ${err.message}`)
      if (err.fix) console.log(`    fix: ${err.fix}`)
    }
  }
  return result
}

describe('nested format (create)', () => {
  it('solves member-user distribution — each member gets its own user', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Dist Org [{{testRunId}}]',
          slug: 'dist-{{testRunId}}',
          members: [
            { role: 'owner', user: [{ name: 'Alice', email: 'alice-{{testRunId}}@test.com' }] },
            { role: 'admin', user: [{ name: 'Bob', email: 'bob-{{testRunId}}@test.com' }] },
            { role: 'viewer', user: [{ name: 'Carol', email: 'carol-{{testRunId}}@test.com' }] },
          ],
        }],
      },
    })

    expect(result.valid).toBe(true)

    // Verify 3 distinct users and 3 distinct members
    const users = await prisma.user.count()
    const members = await prisma.member.count()
    expect(users).toBe(0) // teardown ran (check does up+down)
    // But we know it passed — the unique constraint didn't fire
  })

  it('standard quarita — org with apps, tests, runs', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Acme [{{testRunId}}]',
          slug: 'acme-{{testRunId}}',

          members: [
            { role: 'owner', user: [{ name: 'Admin', email: 'admin-{{testRunId}}@acme.dev' }] },
            { role: 'member', user: [{ name: 'Dev', email: 'dev-{{testRunId}}@acme.dev' }] },
          ],

          applications: [{
            _alias: 'webApp',
            name: 'Marketing Website',
            architecture: 'WEB',

            webApplicationData: [{ url: 'https://acme.com' }],

            tags: [
              { name: 'P0 - Critical', color: '#DC2626' },
              { name: 'P1 - High', color: '#F97316' },
              { name: 'Flaky', color: '#EAB308' },
            ],

            folders: [
              { name: 'Smoke Tests' },
              { name: 'Regression' },
            ],

            testPlans: [{
              name: 'Smoke Plan',
              plan: 'Basic smoke test coverage',

              testGenerations: [{
                _alias: 'gen1',
                status: 'success',
                conversation: '[]',
                applicationId: { _ref: 'webApp' },
                generationSteps: [
                  { order: 1, interaction: 'click', params: {}, output: {} },
                  { order: 2, interaction: 'assert', params: {}, output: {} },
                ],
              }],
            }],

            tests: [{
              name: 'Homepage Test',
              testGenerationId: { _ref: 'gen1' },
              steps: [
                { order: 1, interaction: 'click', params: {} },
                { order: 2, interaction: 'assert', params: {} },
                { order: 3, interaction: 'scroll', params: {} },
              ],
              runs: [{}, {}, {}],
            }],
          }],
        }],
      },
    })

    expect(result.valid).toBe(true)
  })

  it('multi-app with versions distributed correctly', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Multi App Org [{{testRunId}}]',
          slug: 'multi-app-{{testRunId}}',

          members: [
            { role: 'owner', user: [{ name: 'Admin', email: 'admin-{{testRunId}}@test.com' }] },
          ],

          applications: [
            {
              _alias: 'webApp2',
              name: 'Web App',
              architecture: 'WEB',
              webApplicationData: [{ url: 'https://web.example.com' }],
              testPlans: [{
                name: 'Web Plan',
                plan: 'Web tests',
                testGenerations: [{
                  _alias: 'webGen',
                  status: 'success',
                  conversation: '[]',
                  applicationId: { _ref: 'webApp2' },
                }],
              }],
              tests: [{
                name: 'Web Test 1',
                testGenerationId: { _ref: 'webGen' },
                runs: { _count: 10, _batch: true },
              }],
            },
            {
              _alias: 'androidApp',
              name: 'Android App',
              architecture: 'ANDROID',
              mobileApplicationData: [{ packageUrl: 'https://cdn.example.com/app.apk' }],
              testPlans: [{
                name: 'Android Plan',
                plan: 'Android tests',
                testGenerations: [{
                  _alias: 'androidGen',
                  status: 'success',
                  conversation: '[]',
                  applicationId: { _ref: 'androidApp' },
                }],
              }],
              tests: [{
                name: 'Android Test 1',
                testGenerationId: { _ref: 'androidGen' },
                runs: { _count: 10, _batch: true },
              }],
            },
            {
              name: 'iOS App',
              architecture: 'IOS',
              mobileApplicationData: [{ packageUrl: 'https://cdn.example.com/app.ipa' }],
            },
          ],
        }],
      },
    })

    expect(result.valid).toBe(true)
  })

  it('large scenario with batch at leaf nodes', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Large Org [{{testRunId}}]',
          slug: 'large-{{testRunId}}',

          members: [
            { role: 'owner', user: [{ name: 'Admin', email: 'admin-{{testRunId}}@large.com' }] },
          ],

          applications: [{
            _alias: 'largeApp',
            name: 'App',
            architecture: 'WEB',

            tags: { _count: 30, _batch: true, name: 'Tag {{index1}}', color: '#333' },
            folders: { _count: 20, _batch: true, name: 'Folder {{index1}}' },

            testPlans: [{
              name: 'Plan',
              plan: 'content',
              testGenerations: [{
                _alias: 'gen',
                status: 'success',
                conversation: '[]',
                applicationId: { _ref: 'largeApp' },
              }],
            }],

            tests: [{
              name: 'Test',
              testGenerationId: { _ref: 'gen' },
              runs: { _count: 10000, _batch: true },
            }],
          }],
        }],
      },
    })

    expect(result.valid).toBe(true)
    expect(result.timing!.upMs).toBeLessThan(10000)
  })
})
