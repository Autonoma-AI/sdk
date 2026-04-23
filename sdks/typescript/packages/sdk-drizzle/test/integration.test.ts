import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { drizzleExecutor } from '../src/index'
import { introspectDatabase, getDialect, createEntities, teardown } from '@autonoma-ai/sdk'
import type { SQLExecutor, ResolvedEntitySpec } from '@autonoma-ai/sdk'

let container: StartedPostgreSqlContainer
let pool: pg.Pool
let executor: SQLExecutor

const dialect = getDialect('postgres')

describe('Drizzle executor + PostgreSQL (testcontainers)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()

    pool = new pg.Pool({ connectionString: container.getConnectionUri() })

    // Create tables via raw SQL
    await pool.query(`
      CREATE TABLE "Organization" (
        id VARCHAR PRIMARY KEY,
        name TEXT NOT NULL,
        "organizationId" VARCHAR
      )
    `)
    await pool.query(`
      CREATE TABLE "User" (
        id VARCHAR PRIMARY KEY,
        email TEXT NOT NULL,
        "organizationId" VARCHAR NOT NULL REFERENCES "Organization"(id)
      )
    `)
    await pool.query(`
      CREATE TABLE "Application" (
        id VARCHAR PRIMARY KEY,
        name TEXT NOT NULL,
        "organizationId" VARCHAR NOT NULL REFERENCES "Organization"(id)
      )
    `)

    // Wire the adapter to a real Drizzle instance backed by the test container.
    const db = drizzle(pool)
    executor = drizzleExecutor(db)
  })

  afterAll(async () => {
    pool?.on('error', () => {}) // Suppress connection termination errors during container shutdown
    await pool?.end()
    await container?.stop()
  })

  afterEach(async () => {
    await pool.query('DELETE FROM "Application"')
    await pool.query('DELETE FROM "User"')
    await pool.query('DELETE FROM "Organization"')
  })

  it('introspects schema from Drizzle executor', async () => {
    const result = await introspectDatabase(executor, dialect, { scopeField: 'organizationId' })
    const schemaInfo = result.schema

    const modelNames = schemaInfo.models.map((m: any) => m.name).sort()
    expect(modelNames).toEqual(['Application', 'Organization', 'User'])

    const userModel = schemaInfo.models.find((m: any) => m.name === 'User')!
    const fieldNames = userModel.fields.map((f: any) => f.name)
    expect(fieldNames).toContain('id')
    expect(fieldNames).toContain('email')
    expect(fieldNames).toContain('organizationId')
  })

  it('creates entities in Postgres', async () => {
    const result = await introspectDatabase(executor, dialect, { scopeField: 'organizationId' })

    const spec: Record<string, ResolvedEntitySpec> = {
      Organization: { count: 1, fields: [{ id: 'org-1', name: 'Test Org', organizationId: 'org-1' }] },
      User: { count: 1, fields: [{ id: 'user-1', email: 'test@test.com', organizationId: 'org-1' }] },
    }
    const results = await createEntities(executor, dialect, result.tableMap, result.columnMaps, spec, { testRunId: 'test-1', refs: {} }, result.enumTypeMaps)

    expect(results.Organization).toHaveLength(1)
    expect(results.Organization[0].id).toBe('org-1')
    expect(results.User).toHaveLength(1)

    // Verify directly
    const { rows } = await pool.query('SELECT count(*) FROM "Organization"')
    expect(Number(rows[0].count)).toBe(1)
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

    const spec: Record<string, ResolvedEntitySpec> = {
      Organization: { count: 2, fields: [
        { id: 'org-a', name: 'Org A', organizationId: 'org-a' },
        { id: 'org-b', name: 'Org B', organizationId: 'org-b' },
      ] },
      User: { count: 2, fields: [
        { id: 'u-a', email: 'a@a.com', organizationId: 'org-a' },
        { id: 'u-b', email: 'b@b.com', organizationId: 'org-b' },
      ] },
    }
    await createEntities(executor, dialect, result.tableMap, result.columnMaps, spec, { testRunId: 'test-1', refs: {} }, result.enumTypeMaps)

    await teardown(executor, dialect, result.tableMap, result.columnMaps, result.schema, 'org-a')

    const { rows: orgRows } = await pool.query('SELECT count(*) FROM "Organization"')
    expect(Number(orgRows[0].count)).toBe(1)
    const { rows: userRows } = await pool.query('SELECT id FROM "User"')
    expect(userRows[0].id).toBe('u-b')
  })

  it('full round-trip: introspect → create → teardown', async () => {
    const result = await introspectDatabase(executor, dialect, { scopeField: 'organizationId' })

    const schemaInfo = result.schema
    expect(schemaInfo.models.length).toBe(3)

    const spec: Record<string, ResolvedEntitySpec> = {
      Organization: { count: 1, fields: [{ id: 'org-rt', name: 'Roundtrip', organizationId: 'org-rt' }] },
      User: { count: 2, fields: [
        { id: 'u1', email: 'u1@test.com', organizationId: 'org-rt' },
        { id: 'u2', email: 'u2@test.com', organizationId: 'org-rt' },
      ] },
      Application: { count: 1, fields: [{ id: 'a1', name: 'MyApp', organizationId: 'org-rt' }] },
    }
    await createEntities(executor, dialect, result.tableMap, result.columnMaps, spec, { testRunId: 'test-1', refs: {} }, result.enumTypeMaps)

    const { rows: before } = await pool.query('SELECT count(*) FROM "User"')
    expect(Number(before[0].count)).toBe(2)

    await teardown(executor, dialect, result.tableMap, result.columnMaps, result.schema, 'org-rt')

    const { rows: after } = await pool.query('SELECT count(*) FROM "Organization"')
    expect(Number(after[0].count)).toBe(0)
  })
})
