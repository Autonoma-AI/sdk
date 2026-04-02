import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { prismaExecutor } from '../src/index'
import { introspectDatabase, getDialect, createEntities, teardown } from '@autonoma-ai/sdk'
import type { SQLExecutor, ResolvedEntitySpec } from '@autonoma-ai/sdk'

const SCHEMA_PATH = resolve(import.meta.dirname, 'prisma/schema.prisma')

let container: StartedPostgreSqlContainer
let prisma: any // PrismaClient — dynamically imported after generation
let executor: SQLExecutor

const dialect = getDialect('postgres')

describe('Prisma executor + PostgreSQL (testcontainers)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    // Start PostgreSQL container
    container = await new PostgreSqlContainer('postgres:16-alpine').start()
    const url = container.getConnectionUri()

    // Push schema to create tables
    execSync(`npx prisma db push --schema ${SCHEMA_PATH} --skip-generate`, {
      env: { ...process.env, DATABASE_URL: url },
      cwd: resolve(import.meta.dirname, '../../..'),
      stdio: 'pipe',
    })

    // Generate client (generates to node_modules/.prisma/client)
    execSync(`npx prisma generate --schema ${SCHEMA_PATH}`, {
      env: { ...process.env, DATABASE_URL: url },
      cwd: resolve(import.meta.dirname, '../../..'),
      stdio: 'pipe',
    })

    // Resolve PrismaClient from the workspace root where prisma generate outputs to
    const workspaceRoot = resolve(import.meta.dirname, '../../..')
    const rootRequire = createRequire(resolve(workspaceRoot, 'package.json'))
    const { PrismaClient } = rootRequire('@prisma/client')
    prisma = new PrismaClient({ datasourceUrl: url })
    await prisma.$connect()

    executor = prismaExecutor(prisma)
  })

  afterAll(async () => {
    await prisma?.$disconnect()
    await container?.stop()
  })

  afterEach(async () => {
    // Clean all data between tests
    await prisma.$transaction([
      prisma.application.deleteMany(),
      prisma.user.deleteMany(),
      prisma.organization.deleteMany(),
    ])
  })

  it('introspects schema via SQL executor', async () => {
    const result = await introspectDatabase(executor, dialect, { scopeField: 'organizationId' })
    const schema = result.schema

    const modelNames = schema.models.map((m: any) => m.name).sort()
    expect(modelNames).toEqual(['Application', 'Organization', 'User'])

    const userModel = schema.models.find((m: any) => m.name === 'User')!
    const fieldNames = userModel.fields.map((f: any) => f.name)
    expect(fieldNames).toContain('id')
    expect(fieldNames).toContain('email')
    expect(fieldNames).toContain('organizationId')
  })

  it('detects FK edges', async () => {
    const result = await introspectDatabase(executor, dialect, { scopeField: 'organizationId' })
    const schema = result.schema

    const userToOrg = schema.edges.find(
      (e: any) => e.from === 'User' && e.to === 'Organization',
    )
    expect(userToOrg).toBeDefined()
    expect(userToOrg!.localField).toBe('organizationId')
    expect(userToOrg!.nullable).toBe(false)
  })

  it('creates entities in Postgres', async () => {
    const result = await introspectDatabase(executor, dialect, { scopeField: 'organizationId' })

    const spec: Record<string, ResolvedEntitySpec> = {
      Organization: { count: 1, fields: [{ id: 'org-1', name: 'Test Org' }] },
      User: { count: 1, fields: [{ id: 'user-1', email: 'test@test.com', organizationId: 'org-1' }] },
    }
    const results = await createEntities(executor, dialect, result.tableMap, result.columnMaps, spec, { testRunId: 'test-1', refs: {} }, result.enumTypeMaps)

    expect(results.Organization).toHaveLength(1)
    expect(results.Organization[0].id).toBe('org-1')
    expect(results.User).toHaveLength(1)

    // Verify directly in Postgres
    const orgCount = await prisma.organization.count()
    expect(orgCount).toBe(1)
    const userCount = await prisma.user.count()
    expect(userCount).toBe(1)
  })

  it('enforces FK constraints', async () => {
    const result = await introspectDatabase(executor, dialect, { scopeField: 'organizationId' })

    const spec: Record<string, ResolvedEntitySpec> = {
      User: { count: 1, fields: [{ id: 'orphan', email: 'x@y.com', organizationId: 'nonexistent' }] },
    }
    await expect(createEntities(executor, dialect, result.tableMap, result.columnMaps, spec, { testRunId: 'test-1', refs: {} }, result.enumTypeMaps)).rejects.toThrow()
  })

  it('tears down scoped data', async () => {
    const result = await introspectDatabase(executor, dialect, { scopeField: 'organizationId' })

    // Create two orgs with users
    const spec: Record<string, ResolvedEntitySpec> = {
      Organization: { count: 2, fields: [
        { id: 'org-a', name: 'Org A' },
        { id: 'org-b', name: 'Org B' },
      ] },
      User: { count: 2, fields: [
        { id: 'u-a', email: 'a@a.com', organizationId: 'org-a' },
        { id: 'u-b', email: 'b@b.com', organizationId: 'org-b' },
      ] },
    }
    await createEntities(executor, dialect, result.tableMap, result.columnMaps, spec, { testRunId: 'test-1', refs: {} }, result.enumTypeMaps)

    // Teardown only org-a
    await teardown(executor, dialect, result.tableMap, result.columnMaps, result.schema, 'org-a')

    // org-b and its user should remain
    expect(await prisma.organization.count()).toBe(1)
    expect(await prisma.user.count()).toBe(1)
    const remaining = await prisma.user.findFirst()
    expect(remaining.id).toBe('u-b')
  })

  it('full round-trip: introspect → create → teardown', async () => {
    const result = await introspectDatabase(executor, dialect, { scopeField: 'organizationId' })

    // Introspect
    expect(result.schema.models.length).toBe(3)

    // Create
    const spec: Record<string, ResolvedEntitySpec> = {
      Organization: { count: 1, fields: [{ id: 'org-rt', name: 'Roundtrip' }] },
      User: { count: 2, fields: [
        { id: 'u1', email: 'u1@test.com', organizationId: 'org-rt' },
        { id: 'u2', email: 'u2@test.com', organizationId: 'org-rt' },
      ] },
      Application: { count: 1, fields: [{ id: 'a1', name: 'MyApp', organizationId: 'org-rt' }] },
    }
    const refs = await createEntities(executor, dialect, result.tableMap, result.columnMaps, spec, { testRunId: 'test-1', refs: {} }, result.enumTypeMaps)

    expect(await prisma.organization.count()).toBe(1)
    expect(await prisma.user.count()).toBe(2)
    expect(await prisma.application.count()).toBe(1)

    // Teardown
    await teardown(executor, dialect, result.tableMap, result.columnMaps, result.schema, 'org-rt', refs)

    expect(await prisma.organization.count()).toBe(0)
    expect(await prisma.user.count()).toBe(0)
    expect(await prisma.application.count()).toBe(0)
  })
})
