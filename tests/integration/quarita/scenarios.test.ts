import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { PrismaClient } from './generated/index.js'
import { prismaAdapter } from '../../../packages/sdk-prisma/src/index'
import { checkScenario } from '../../../packages/sdk/src/check'
import type { OrmAdapter, ScenarioDefinition } from '../../../packages/sdk/src/types'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = join(__dirname, 'prisma/schema.prisma')

let container: StartedPostgreSqlContainer
let prisma: PrismaClient
let adapter: OrmAdapter

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  execSync(`npx prisma db push --schema ${SCHEMA_PATH} --skip-generate --accept-data-loss`, {
    env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    stdio: 'pipe',
  })
  prisma = new PrismaClient({ datasourceUrl: container.getConnectionUri() })
  adapter = prismaAdapter(prisma, { scopeField: 'organizationId' })
}, 60_000)

afterAll(async () => {
  await prisma.$disconnect()
  await container.stop()
})

async function cleanDB() {
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

async function check(scenario: ScenarioDefinition) {
  const result = await checkScenario(adapter, scenario)
  if (!result.valid) {
    for (const err of result.errors) {
      const lines = err.message.split('\n').filter((l: string) => l.trim() && !l.includes('packages/'))
      console.log(`  [${result.phase}] ${lines[lines.length - 1]?.trim() ?? err.message.slice(0, 200)}`)
    }
  }
  return result
}

// ── Scenarios ─────────────────────────────────────────────────────────────

describe('quarita scenarios', () => {
  afterEach(async () => {
    await cleanDB()
  })

  // ── Empty states ──────────────────────────────────────────────────────

  it('empty — org + user only', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Empty Org [{{testRunId}}]',
          slug: 'empty-{{testRunId}}',
          members: [{ role: 'owner', user: [{ name: 'Solo User', email: 'solo-{{testRunId}}@test.com' }] }],
        }],
      },
    })
    expect(result.valid).toBe(true)
    expect(result.phase).toBe('ok')
  })

  // ── Standard CRUD ─────────────────────────────────────────────────────

  it('standard — org with app, plan, test, runs', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Std Org [{{testRunId}}]',
          slug: 'std-{{testRunId}}',
          members: [{ role: 'owner', user: [{ name: 'Admin', email: 'admin-{{testRunId}}@test.com' }] }],
          applications: [{
            _alias: 'app',
            name: 'Web App',
            architecture: 'WEB',
            webApplicationData: [{ url: 'https://app.example.com' }],
            tags: [
              { name: 'Critical', color: '#FF0000' },
              { name: 'High', color: '#FF8800' },
              { name: 'Medium', color: '#FFFF00' },
            ],
            folders: [
              { name: 'Smoke' },
              { name: 'Regression' },
            ],
            testPlans: [{
              name: 'Smoke Plan',
              plan: 'content',
              testGenerations: [{
                _alias: 'gen1',
                conversation: '[]',
                status: 'success',
                applicationId: { _ref: 'app' },
              }],
            }],
            tests: [{
              name: 'Homepage Test',
              testGenerationId: { _ref: 'gen1' },
              steps: [
                { order: 1, interaction: 'click', params: {} },
                { order: 2, interaction: 'type', params: {} },
                { order: 3, interaction: 'assert', params: {} },
              ],
              runs: [{}, {}, {}, {}, {}],
            }],
          }],
        }],
      },
    })
    expect(result.valid).toBe(true)
  })

  // ── Every model type ──────────────────────────────────────────────────

  it('single-each — exactly 1 of every entity type including RunStep', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Single [{{testRunId}}]',
          slug: 'single-{{testRunId}}',
          members: [{
            _alias: 'member1',
            role: 'owner',
            user: [{
              _alias: 'user1',
              name: 'User',
              email: 'single-{{testRunId}}@test.com',
              apiKeys: [{ key: 'key-{{testRunId}}' }],
            }],
          }],
          invitations: [{
            email: 'inv-{{testRunId}}@test.com',
            inviterId: { _ref: 'user1' },
            role: 'member',
            expiresAt: '{{now()}}',
          }],
          applications: [{
            _alias: 'app',
            name: 'App',
            architecture: 'WEB',
            webApplicationData: [{ url: 'https://single.com' }],
            tags: [{ _alias: 'tag1', name: 'Tag1', color: '#000' }],
            folders: [{ name: 'Root' }],
            testPlans: [{
              name: 'Plan',
              plan: 'x',
              testGenerations: [{
                _alias: 'gen1',
                conversation: '[]',
                applicationId: { _ref: 'app' },
                generationSteps: [{ order: 1, interaction: 'click', params: {}, output: {} }],
              }],
            }],
            tests: [{
              _alias: 'test1',
              name: 'Test',
              testGenerationId: { _ref: 'gen1' },
              testTags: [{ tagId: { _ref: 'tag1' } }],
              steps: [{ _alias: 'step1', order: 1, interaction: 'click', params: {} }],
              runs: [{
                steps: [{ testStepId: { _ref: 'step1' }, order: 1, status: 'passed', output: {} }],
              }],
            }],
          }],
        }],
      },
    })
    expect(result.valid).toBe(true)
  })

  // ── Deep FK chain ─────────────────────────────────────────────────────

  it('deep-chain — max FK depth org→app→plan→gen→test→step→run→runstep', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Deep [{{testRunId}}]',
          slug: 'deep-{{testRunId}}',
          members: [{ role: 'owner', user: [{ name: 'User', email: 'deep-{{testRunId}}@test.com' }] }],
          applications: [{
            _alias: 'app',
            name: 'App',
            architecture: 'WEB',
            testPlans: [{
              name: 'Plan',
              plan: 'deep',
              testGenerations: [{
                _alias: 'gen1',
                conversation: '[]',
                status: 'success',
                applicationId: { _ref: 'app' },
                generationSteps: [
                  { order: 1, interaction: 'click', params: {}, output: {} },
                  { order: 2, interaction: 'type', params: {}, output: {} },
                  { order: 3, interaction: 'assert', params: {}, output: {} },
                  { order: 4, interaction: 'scroll', params: {}, output: {} },
                  { order: 5, interaction: 'wait', params: {}, output: {} },
                ],
              }],
            }],
            tests: [{
              name: 'Deep Test',
              testGenerationId: { _ref: 'gen1' },
              steps: [
                { _alias: 'step1', order: 1, interaction: 'click', params: {} },
                { order: 2, interaction: 'type', params: {} },
                { order: 3, interaction: 'assert', params: {} },
                { order: 4, interaction: 'scroll', params: {} },
                { order: 5, interaction: 'wait', params: {} },
              ],
              runs: [{
                steps: [{ testStepId: { _ref: 'step1' }, order: 1, status: 'passed', output: {} }],
              }],
            }],
          }],
        }],
      },
    })
    expect(result.valid).toBe(true)
  })

  // ── Wide shapes ───────────────────────────────────────────────────────

  it('wide — 100 applications in one org', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Wide [{{testRunId}}]',
          slug: 'wide-{{testRunId}}',
          members: [{ role: 'owner', user: [{ name: 'User', email: 'wide-{{testRunId}}@test.com' }] }],
          applications: [{ _count: 100, name: 'App {{index1}}', architecture: "{{cycle(['WEB','ANDROID','IOS'])}}" }],
        }],
      },
    })
    expect(result.valid).toBe(true)
  })

  it('wide — 50 users', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Multi [{{testRunId}}]',
          slug: 'multi-{{testRunId}}',
          members: [{
            role: 'owner',
            user: [{ _count: 50, name: 'User {{index1}}', email: 'u-{{index1}}-{{testRunId}}@test.com' }],
          }],
        }],
      },
    })
    expect(result.valid).toBe(true)
  })

  // ── Batch / bulk ──────────────────────────────────────────────────────

  it('batch — 10,000 runs', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Heavy [{{testRunId}}]',
          slug: 'heavy-{{testRunId}}',
          members: [{ role: 'owner', user: [{ name: 'User', email: 'heavy-{{testRunId}}@test.com' }] }],
          applications: [{
            _alias: 'app',
            name: 'App',
            architecture: 'WEB',
            testPlans: [{
              name: 'Plan',
              plan: 'x',
              testGenerations: [{
                _alias: 'gen1',
                conversation: '[]',
                applicationId: { _ref: 'app' },
              }],
            }],
            tests: [{
              name: 'Test',
              testGenerationId: { _ref: 'gen1' },
              runs: [{ _count: 10000, _batch: true }],
            }],
          }],
        }],
      },
    })
    expect(result.valid).toBe(true)
    expect(result.timing!.upMs).toBeLessThan(5000) // should be under 5s
  })

  it('batch — 500 test steps', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Steps [{{testRunId}}]',
          slug: 'steps-{{testRunId}}',
          members: [{ role: 'owner', user: [{ name: 'User', email: 'steps-{{testRunId}}@test.com' }] }],
          applications: [{
            _alias: 'app',
            name: 'App',
            architecture: 'WEB',
            testPlans: [{
              name: 'Plan',
              plan: 'x',
              testGenerations: [{
                _alias: 'gen1',
                conversation: '[]',
                applicationId: { _ref: 'app' },
              }],
            }],
            tests: [{
              name: 'Mega',
              testGenerationId: { _ref: 'gen1' },
              steps: [{ _count: 500, _batch: true, order: '{{index1}}', interaction: "{{cycle(['click','type','assert'])}}", params: {} }],
            }],
          }],
        }],
      },
    })
    expect(result.valid).toBe(true)
  })

  it('batch — 200 tags', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Tags [{{testRunId}}]',
          slug: 'tags-{{testRunId}}',
          members: [{ role: 'owner', user: [{ name: 'User', email: 'tags-{{testRunId}}@test.com' }] }],
          applications: [{
            name: 'App',
            architecture: 'WEB',
            tags: [{ _count: 200, _batch: true, name: 'Tag {{index1}}', color: "{{cycle(['#F00','#0F0','#00F'])}}" }],
          }],
        }],
      },
    })
    expect(result.valid).toBe(true)
  })

  // ── Mobile app (different data model) ─────────────────────────────────

  it('mobile — iOS app with MobileApplicationData', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Mobile [{{testRunId}}]',
          slug: 'mobile-{{testRunId}}',
          members: [{ role: 'owner', user: [{ name: 'Dev', email: 'mobile-{{testRunId}}@test.com' }] }],
          applications: [{
            name: 'iOS Banking',
            architecture: 'IOS',
            mobileApplicationData: [{ packageUrl: 'https://cdn.example.com/app.ipa' }],
          }],
        }],
      },
    })
    expect(result.valid).toBe(true)
  })

  // ── Invitations / auth models ─────────────────────────────────────────

  it('invitations — pending invitations and API keys', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Invite [{{testRunId}}]',
          slug: 'invite-{{testRunId}}',
          members: [{
            role: 'owner',
            user: [{
              _alias: 'inviter',
              name: 'Inviter',
              email: 'inviter-{{testRunId}}@test.com',
              apiKeys: [
                { key: 'key-0-{{testRunId}}' },
                { key: 'key-1-{{testRunId}}' },
                { key: 'key-2-{{testRunId}}' },
              ],
            }],
          }],
          invitations: [
            { email: 'inv-1-{{testRunId}}@test.com', inviterId: { _ref: 'inviter' }, role: 'admin', expiresAt: '{{now()}}' },
            { email: 'inv-2-{{testRunId}}@test.com', inviterId: { _ref: 'inviter' }, role: 'member', expiresAt: '{{now()}}' },
            { email: 'inv-3-{{testRunId}}@test.com', inviterId: { _ref: 'inviter' }, role: 'member', expiresAt: '{{now()}}' },
            { email: 'inv-4-{{testRunId}}@test.com', inviterId: { _ref: 'inviter' }, role: 'member', expiresAt: '{{now()}}' },
            { email: 'inv-5-{{testRunId}}@test.com', inviterId: { _ref: 'inviter' }, role: 'member', expiresAt: '{{now()}}' },
          ],
        }],
      },
    })
    expect(result.valid).toBe(true)
  })

  // ── Full load ─────────────────────────────────────────────────────────

  it('full-load — 5 apps, 10 plans, 10k runs', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Full [{{testRunId}}]',
          slug: 'full-{{testRunId}}',
          members: [{
            role: 'owner',
            user: [{ name: 'User 1', email: 'u-1-{{testRunId}}@full.com' }],
          }],
          applications: [{
            _alias: 'app',
            name: 'Web',
            architecture: 'WEB',
            folders: [{ _count: 20, _batch: true, name: 'Folder {{index1}}' }],
            tags: [{ _count: 30, _batch: true, name: 'Tag {{index1}}', color: '#333' }],
            testPlans: [
              { name: 'Plan 1', plan: 'Content' },
              { name: 'Plan 2', plan: 'Content' },
              { name: 'Plan 3', plan: 'Content' },
              { name: 'Plan 4', plan: 'Content' },
              { name: 'Plan 5', plan: 'Content' },
              { name: 'Plan 6', plan: 'Content' },
              { name: 'Plan 7', plan: 'Content' },
              { name: 'Plan 8', plan: 'Content' },
              { name: 'Plan 9', plan: 'Content' },
              {
                name: 'Plan 10',
                plan: 'Content',
                testGenerations: [{
                  _alias: 'gen1',
                  conversation: '[]',
                  status: 'success',
                  applicationId: { _ref: 'app' },
                }],
              },
            ],
            tests: [{
              name: 'Load Test',
              testGenerationId: { _ref: 'gen1' },
              runs: [{ _count: 10000, _batch: true }],
            }],
          },
          { name: 'Android', architecture: 'ANDROID' },
          { name: 'iOS', architecture: 'IOS' },
          { name: 'Desktop', architecture: 'WEB' },
          { name: 'API', architecture: 'WEB' },
          ],
        }],
      },
    })
    expect(result.valid).toBe(true)
    expect(result.timing!.upMs).toBeLessThan(10000)
  })

  // ── Error cases — nested format ───────────────────────────────────────

  describe('nested format error cases', () => {
    it('catches unique constraint violation', async () => {
      const result = await check({
        create: {
          Organization: [
            { name: 'Org', slug: 'same' },
            { name: 'Org2', slug: 'same' },
          ],
        },
      })
      expect(result.valid).toBe(false)
      expect(result.phase).toBe('up')
      expect(result.errors[0]!.message).toContain('Unique constraint')
    })

    it('catches invalid enum value', async () => {
      const result = await check({
        create: {
          Organization: [{
            name: 'Org [{{testRunId}}]',
            slug: 'enum-{{testRunId}}',
            applications: [{ name: 'App', architecture: 'INVALID' }],
          }],
        },
      })
      expect(result.valid).toBe(false)
      expect(result.phase).toBe('up')
    })
  })
})
