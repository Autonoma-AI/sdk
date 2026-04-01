import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql'
import mysql from 'mysql2/promise'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkScenario } from '../../../packages/sdk/src/check'
import { mysqlExecutor } from '../../../packages/sdk-mysql/src/index'
import type { SQLExecutor, ScenarioDefinition } from '../../../packages/sdk/src/types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, 'schema.sql'), 'utf-8')

let container: StartedMySqlContainer
let pool: mysql.Pool
let executor: SQLExecutor
let dbName: string

beforeAll(async () => {
  container = await new MySqlContainer('mysql:8.0').start()
  dbName = container.getDatabase()

  pool = mysql.createPool({
    host: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    password: container.getUserPassword(),
    database: dbName,
    // MySQL needs multiStatements to execute the DDL in one go
    multipleStatements: true,
  })

  await pool.query(SCHEMA_SQL)

  // For actual operations, use a pool without multipleStatements
  // (the executor wrapper just passes single statements)
  executor = mysqlExecutor(pool as any)
}, 120_000) // MySQL container is slower to start

afterAll(async () => {
  await pool.end()
  await container.stop()
})

async function cleanDB() {
  await pool.query('SET FOREIGN_KEY_CHECKS = 0')
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT TABLE_NAME AS tbl FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
    [dbName],
  )
  for (const row of rows) {
    await pool.query(`TRUNCATE TABLE \`${row.tbl}\``)
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1')
}

async function check(scenario: ScenarioDefinition) {
  const result = await checkScenario(executor, scenario, {
    scopeField: 'organizationId',
    dialect: 'mysql',
    dbSchema: dbName,
  })
  if (!result.valid) {
    for (const err of result.errors) {
      console.log(`  [${result.phase}] ${err.message.slice(0, 200)}`)
    }
  }
  return result
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('mysql raw SQL — e2e', () => {
  afterEach(async () => {
    await cleanDB()
  })

  it('introspects tables, FK edges, and enums from information_schema', async () => {
    const { handleRequest } = await import('../../../packages/sdk/src/handler')
    const { signBody } = await import('../../../packages/sdk/src/hmac')

    const secret = 'test-secret'
    const body = JSON.stringify({ action: 'discover' })
    const res = await handleRequest(
      {
        executor,
        scopeField: 'organizationId',
        dialect: 'mysql',
        dbSchema: dbName,
        sharedSecret: secret,
        signingSecret: 'sign-secret',
      },
      { body, headers: { 'x-signature': signBody(body, secret) } },
    )

    expect(res.status).toBe(200)
    const schema = (res.body as any).schema
    expect(schema.models.length).toBeGreaterThanOrEqual(10)
    expect(schema.edges.length).toBeGreaterThanOrEqual(10)

    // Check Organization model
    const orgModel = schema.models.find((m: any) => m.name === 'Organization')
    expect(orgModel).toBeDefined()
    expect(orgModel.fields.some((f: any) => f.name === 'name')).toBe(true)

    // Check MySQL enum was parsed from column_type
    const appModel = schema.models.find((m: any) => m.name === 'Application')
    const archField = appModel?.fields.find((f: any) => f.name === 'architecture')
    expect(archField?.type).toContain('enum')
    expect(archField?.type).toContain('WEB')
  })

  it('empty — org only', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Empty Org [{{testRunId}}]',
          slug: 'empty-{{testRunId}}',
        }],
      },
    })
    expect(result.valid).toBe(true)
    expect(result.phase).toBe('ok')
  })

  it('org with member and user', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Org [{{testRunId}}]',
          slug: 'org-{{testRunId}}',
          members: [{
            role: 'owner',
            user: [{ name: 'User', email: 'user-{{testRunId}}@test.com' }],
          }],
        }],
      },
    })
    expect(result.valid).toBe(true)
  })

  it('deep FK chain — org → app → plan → gen → test → step → run → runstep', async () => {
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
              }],
            }],
            tests: [{
              name: 'Test',
              testGenerationId: { _ref: 'gen1' },
              testSteps: [
                { _alias: 'step1', order: 1, interaction: 'click', params: {} },
              ],
              runs: [{
                runSteps: [{ testStepId: { _ref: 'step1' }, order: 1, status: 'passed', output: {} }],
              }],
            }],
          }],
        }],
      },
    })
    expect(result.valid).toBe(true)
  })

  it('wide — 50 applications', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Wide [{{testRunId}}]',
          slug: 'wide-{{testRunId}}',
          members: [{ role: 'owner', user: [{ name: 'User', email: 'wide-{{testRunId}}@test.com' }] }],
          applications: [{ _count: 50, name: 'App {{index1}}', architecture: "{{cycle(['WEB','ANDROID','IOS'])}}" }],
        }],
      },
    })
    expect(result.valid).toBe(true)
  })

  it('batch — 500 runs', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Batch [{{testRunId}}]',
          slug: 'batch-{{testRunId}}',
          members: [{ role: 'owner', user: [{ name: 'User', email: 'batch-{{testRunId}}@test.com' }] }],
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
              runs: [{ _count: 500, _batch: true }],
            }],
          }],
        }],
      },
    })
    expect(result.valid).toBe(true)
  })

  it('invitations and API keys', async () => {
    const result = await check({
      create: {
        Organization: [{
          name: 'Inv [{{testRunId}}]',
          slug: 'inv-{{testRunId}}',
          members: [{
            role: 'owner',
            user: [{
              _alias: 'inviter',
              name: 'Inviter',
              email: 'inviter-{{testRunId}}@test.com',
              apiKeys: [
                { key: 'key-0-{{testRunId}}' },
                { key: 'key-1-{{testRunId}}' },
              ],
            }],
          }],
          invitations: [
            { email: 'inv-1-{{testRunId}}@test.com', inviterId: { _ref: 'inviter' }, role: 'admin', expiresAt: '{{now()}}' },
            { email: 'inv-2-{{testRunId}}@test.com', inviterId: { _ref: 'inviter' }, role: 'member', expiresAt: '{{now()}}' },
          ],
        }],
      },
    })
    expect(result.valid).toBe(true)
  })

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
