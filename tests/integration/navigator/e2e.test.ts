/**
 * Navigator E2E — three scenarios (empty, standard, large) against real Postgres.
 * Uses testcontainers. All scenarios use nested `create` format.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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

// ── Tests ─────────────────────────────────────────────────────────────────

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
  adapter = prismaAdapter(prisma, { scopeField: 'organizationID' })
}, 60_000)

afterAll(async () => {
  await prisma.$disconnect()
  await container.stop()
})

async function check(scenario: ScenarioDefinition) {
  const result = await checkScenario(adapter, scenario)
  if (!result.valid) {
    for (const err of result.errors) {
      console.log(`  [${result.phase}] ${err.message}`)
      if (err.fix) console.log(`  fix: ${err.fix}`)
    }
  }
  return result
}

describe('navigator e2e', () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(`${name} scenario`, async () => {
      const result = await check(scenario)
      expect(result.valid).toBe(true)
      expect(result.phase).toBe('ok')
    })
  }
})
