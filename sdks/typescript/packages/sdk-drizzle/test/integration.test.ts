import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import pg from 'pg'
import { pgTable, text, varchar } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { drizzleAdapter } from '../src/index'

// Define test schema using Drizzle's pgTable
export const organizations = pgTable('Organization', {
  id: varchar('id').primaryKey(),
  name: text('name').notNull(),
  organizationId: varchar('organizationId'),
})

export const users = pgTable('User', {
  id: varchar('id').primaryKey(),
  email: text('email').notNull(),
  organizationId: varchar('organizationId').notNull().references(() => organizations.id),
})

export const applications = pgTable('Application', {
  id: varchar('id').primaryKey(),
  name: text('name').notNull(),
  organizationId: varchar('organizationId').notNull().references(() => organizations.id),
})

const schema = { organizations, users, applications }

let container: StartedPostgreSqlContainer
let pool: pg.Pool
let db: ReturnType<typeof drizzle>

describe('Drizzle adapter + PostgreSQL (testcontainers)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()

    pool = new pg.Pool({ connectionString: container.getConnectionUri() })
    db = drizzle(pool, { schema })

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
  })

  afterAll(async () => {
    await pool?.end()
    await container?.stop()
  })

  afterEach(async () => {
    await db.execute(sql`DELETE FROM "Application"`)
    await db.execute(sql`DELETE FROM "User"`)
    await db.execute(sql`DELETE FROM "Organization"`)
  })

  it('introspects schema from Drizzle tables', () => {
    const adapter = drizzleAdapter(db, schema, { scopeField: 'organizationId' })
    const schemaInfo = adapter.getSchema()

    const modelNames = schemaInfo.models.map((m: any) => m.name).sort()
    expect(modelNames).toEqual(['Application', 'Organization', 'User'])

    const userModel = schemaInfo.models.find((m: any) => m.name === 'User')!
    const fieldNames = userModel.fields.map((f: any) => f.name)
    expect(fieldNames).toContain('id')
    expect(fieldNames).toContain('email')
    expect(fieldNames).toContain('organizationId')
  })

  it('creates entities in Postgres', async () => {
    const adapter = drizzleAdapter(db, schema, { scopeField: 'organizationId' })

    const spec = {
      Organization: { count: 1, fields: [{ id: 'org-1', name: 'Test Org', organizationId: 'org-1' }] },
      User: { count: 1, fields: [{ id: 'user-1', email: 'test@test.com', organizationId: 'org-1' }] },
    }
    const results = await adapter.createEntities(spec, { testRunId: 'test-1', refs: {} })

    expect(results.Organization).toHaveLength(1)
    expect(results.Organization[0].id).toBe('org-1')
    expect(results.User).toHaveLength(1)

    // Verify directly
    const { rows } = await pool.query('SELECT count(*) FROM "Organization"')
    expect(Number(rows[0].count)).toBe(1)
  })

  it('enforces FK constraints', async () => {
    const adapter = drizzleAdapter(db, schema, { scopeField: 'organizationId' })

    const spec = {
      User: { count: 1, fields: [{ id: 'orphan', email: 'x@y.com', organizationId: 'nonexistent' }] },
    }
    await expect(adapter.createEntities(spec, { testRunId: 'test-1', refs: {} })).rejects.toThrow()
  })

  it('tears down scoped data', async () => {
    const adapter = drizzleAdapter(db, schema, { scopeField: 'organizationId' })

    const spec = {
      Organization: { count: 2, fields: [
        { id: 'org-a', name: 'Org A', organizationId: 'org-a' },
        { id: 'org-b', name: 'Org B', organizationId: 'org-b' },
      ] },
      User: { count: 2, fields: [
        { id: 'u-a', email: 'a@a.com', organizationId: 'org-a' },
        { id: 'u-b', email: 'b@b.com', organizationId: 'org-b' },
      ] },
    }
    await adapter.createEntities(spec, { testRunId: 'test-1', refs: {} })

    await adapter.teardown('org-a')

    const { rows: orgRows } = await pool.query('SELECT count(*) FROM "Organization"')
    expect(Number(orgRows[0].count)).toBe(1)
    const { rows: userRows } = await pool.query('SELECT id FROM "User"')
    expect(userRows[0].id).toBe('u-b')
  })

  it('full round-trip: introspect → create → teardown', async () => {
    const adapter = drizzleAdapter(db, schema, { scopeField: 'organizationId' })

    const schemaInfo = adapter.getSchema()
    expect(schemaInfo.models.length).toBe(3)

    const spec = {
      Organization: { count: 1, fields: [{ id: 'org-rt', name: 'Roundtrip', organizationId: 'org-rt' }] },
      User: { count: 2, fields: [
        { id: 'u1', email: 'u1@test.com', organizationId: 'org-rt' },
        { id: 'u2', email: 'u2@test.com', organizationId: 'org-rt' },
      ] },
      Application: { count: 1, fields: [{ id: 'a1', name: 'MyApp', organizationId: 'org-rt' }] },
    }
    await adapter.createEntities(spec, { testRunId: 'test-1', refs: {} })

    const { rows: before } = await pool.query('SELECT count(*) FROM "User"')
    expect(Number(before[0].count)).toBe(2)

    await adapter.teardown('org-rt')

    const { rows: after } = await pool.query('SELECT count(*) FROM "Organization"')
    expect(Number(after[0].count)).toBe(0)
  })
})
