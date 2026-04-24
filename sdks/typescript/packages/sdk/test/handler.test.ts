import { describe, it, expect, vi } from 'vitest'
import { handleRequest } from '../src/handler.js'
import { signBody } from '../src/hmac.js'
import { signRefs } from '../src/refs.js'
import { defineFactory } from '../src/factory.js'
import type { AuthResult, FactoryContext, HandlerConfig, HookContext, SQLExecutor } from '../src/types.js'

/**
 * Create a mock SQLExecutor that returns canned information_schema data
 * and captures INSERT/DELETE/UPDATE queries.
 */
function createMockExecutor(): SQLExecutor & { queries: string[] } {
  const queries: string[] = []

  const mockTables = [{ table_name: 'organization' }, { table_name: 'user' }]
  const mockColumns = [
    { table_name: 'organization', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: 'gen_random_uuid()' },
    { table_name: 'organization', column_name: 'name', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null },
    { table_name: 'user', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: 'gen_random_uuid()' },
    { table_name: 'user', column_name: 'email', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null },
    { table_name: 'user', column_name: 'name', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null },
    { table_name: 'user', column_name: 'organization_id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: null },
  ]
  const mockPKs = [
    { table_name: 'organization', column_name: 'id' },
    { table_name: 'user', column_name: 'id' },
  ]
  const mockFKs = [
    { from_table: 'user', from_column: 'organization_id', to_table: 'organization', to_column: 'id', is_nullable: 'NO' },
  ]

  let insertCounter = 0

  const executor: SQLExecutor & { queries: string[] } = {
    queries,
    async query<T = Record<string, unknown>>(sql: string, _params?: unknown[]): Promise<T[]> {
      queries.push(sql)
      const trimmed = sql.trim().toLowerCase()

      // Introspection queries — order matters: FK before PK (both match table_constraints)
      if (trimmed.includes('information_schema.tables') && !trimmed.includes('table_constraints')) return mockTables as T[]
      if (trimmed.includes('information_schema.columns') && !trimmed.includes('table_constraints')) return mockColumns as T[]
      if (trimmed.includes('foreign key')) return mockFKs as T[]
      if (trimmed.includes('primary key')) return mockPKs as T[]
      if (trimmed.includes('pg_type')) return [] as T[]

      // INSERT: return a fake record with id
      if (trimmed.startsWith('insert')) {
        const id = `mock-id-${insertCounter++}`
        // Parse out the columns and values to build a plausible return
        const record: Record<string, unknown> = { id }
        if (_params) {
          // Try to extract column names from the SQL
          const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i)
          if (colMatch) {
            const cols = colMatch[1]!.split(',').map((c) => c.trim().replace(/"/g, ''))
            for (let i = 0; i < cols.length; i++) {
              record[cols[i]!] = _params[i]
            }
          }
        }
        return [record] as T[]
      }

      // DELETE/UPDATE: return empty
      return [] as T[]
    },

    async transaction<T>(fn: (tx: SQLExecutor) => Promise<T>): Promise<T> {
      return fn(executor)
    },
  }

  return executor
}

function createConfig(overrides?: Partial<HandlerConfig>): HandlerConfig {
  return {
    executor: createMockExecutor(),
    scopeField: 'organizationId',
    sharedSecret: 'test-secret',
    signingSecret: 'test-signing-secret',
    auth: async (user, _ctx) => ({ headers: { Authorization: `Bearer jwt-token-${user?.id ?? 'anon'}` } }),
    ...overrides,
  }
}

function signedRequest(body: Record<string, unknown>, secret: string) {
  const raw = JSON.stringify(body)
  return {
    body: raw,
    headers: { 'x-signature': signBody(raw, secret) },
  }
}

describe('handleRequest', () => {
  describe('environment gating', () => {
    it('returns 404 in production when not allowed', async () => {
      const original = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      try {
        const config = createConfig()
        const req = signedRequest({ action: 'discover' }, config.sharedSecret)
        const res = await handleRequest(config, req)
        expect(res.status).toBe(404)
        expect(res.body.code).toBe('PRODUCTION_BLOCKED')
      } finally {
        process.env.NODE_ENV = original
      }
    })

    it('allows production when configured', async () => {
      const original = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      try {
        const config = createConfig({ allowProduction: true })
        const req = signedRequest({ action: 'discover' }, config.sharedSecret)
        const res = await handleRequest(config, req)
        expect(res.status).toBe(200)
      } finally {
        process.env.NODE_ENV = original
      }
    })

    it('allows production when AUTONOMA_ENABLED is truthy', async () => {
      const originalNode = process.env.NODE_ENV
      const originalEnabled = process.env.AUTONOMA_ENABLED
      process.env.NODE_ENV = 'production'
      process.env.AUTONOMA_ENABLED = '1'
      try {
        const config = createConfig()
        const req = signedRequest({ action: 'discover' }, config.sharedSecret)
        const res = await handleRequest(config, req)
        expect(res.status).toBe(200)
      } finally {
        process.env.NODE_ENV = originalNode
        if (originalEnabled === undefined) delete process.env.AUTONOMA_ENABLED
        else process.env.AUTONOMA_ENABLED = originalEnabled
      }
    })

    it('does not treat AUTONOMA_ENABLED=0 as enabled', async () => {
      const originalNode = process.env.NODE_ENV
      const originalEnabled = process.env.AUTONOMA_ENABLED
      process.env.NODE_ENV = 'production'
      process.env.AUTONOMA_ENABLED = '0'
      try {
        const config = createConfig()
        const req = signedRequest({ action: 'discover' }, config.sharedSecret)
        const res = await handleRequest(config, req)
        expect(res.status).toBe(404)
        expect(res.body.code).toBe('PRODUCTION_BLOCKED')
      } finally {
        process.env.NODE_ENV = originalNode
        if (originalEnabled === undefined) delete process.env.AUTONOMA_ENABLED
        else process.env.AUTONOMA_ENABLED = originalEnabled
      }
    })
  })

  describe('HMAC', () => {
    it('rejects invalid signature', async () => {
      const config = createConfig()
      const res = await handleRequest(config, {
        body: '{"action":"discover"}',
        headers: { 'x-signature': 'bad' },
      })
      expect(res.status).toBe(401)
      expect(res.body.code).toBe('INVALID_SIGNATURE')
    })

    it('rejects missing signature', async () => {
      const config = createConfig()
      const res = await handleRequest(config, {
        body: '{"action":"discover"}',
        headers: {},
      })
      expect(res.status).toBe(401)
    })
  })

  describe('discover', () => {
    it('returns schema from database introspection', async () => {
      const config = createConfig()
      const req = signedRequest({ action: 'discover' }, config.sharedSecret)
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      const body = res.body as any
      expect(body.schema).toBeDefined()
      expect(body.schema.models).toHaveLength(2)
      expect(body.schema.models.map((m: any) => m.name).sort()).toEqual(['Organization', 'User'])
      expect(body.schema.edges).toHaveLength(1)
      expect(body.schema.edges[0].from).toBe('User')
      expect(body.schema.edges[0].to).toBe('Organization')
      expect(body.version).toBe('1.0')
      expect(body.sdk).toMatchObject({ language: 'typescript' })
    })
  })

  describe('up', () => {
    it('creates entities and returns auth + refs + refsToken', async () => {
      const config = createConfig()
      const req = signedRequest(
        { action: 'up', create: { Organization: [{ name: 'Org' }] }, testRunId: 'run-123' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      const body = res.body as any
      expect(body.refs).toBeDefined()
      expect(body.refsToken).toBeDefined()
      expect(typeof body.refsToken).toBe('string')
      expect(body.version).toBe('1.0')
      expect(body.sdk).toMatchObject({ language: 'typescript' })
    })
  })

  describe('down', () => {
    it('tears down with valid refsToken', async () => {
      const config = createConfig()
      const refsToken = signRefs(
        { refs: {}, testRunId: 'run-123', environment: 'standard' },
        config.signingSecret,
      )
      const req = signedRequest(
        { action: 'down', refsToken },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ ok: true, version: '1.0', sdk: { language: 'typescript' } })
    })

    it('rejects tampered refsToken', async () => {
      const config = createConfig()
      const req = signedRequest(
        { action: 'down', refsToken: 'bad.token.here' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('INVALID_REFS_TOKEN')
    })
  })

  describe('hooks', () => {
    it('afterUp hook is called and can modify auth result', async () => {
      const afterUpSpy = vi.fn((ctx: HookContext, auth: AuthResult): AuthResult => ({
        ...auth,
        headers: { ...auth.headers, 'X-Custom': 'enriched' },
      }))
      const config = createConfig({ afterUp: afterUpSpy })
      const req = signedRequest(
        { action: 'up', create: { Organization: [{ name: 'Org' }] }, testRunId: 'run-123' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      expect(afterUpSpy).toHaveBeenCalledOnce()
      const [ctx] = afterUpSpy.mock.calls[0]!
      expect(ctx.scenarioName).toBeDefined()
      expect(ctx.refs).toBeDefined()
      const body = res.body as any
      expect(body.auth.headers['X-Custom']).toBe('enriched')
    })

    it('beforeDown hook is called before teardown', async () => {
      const beforeDownSpy = vi.fn()
      const config = createConfig({ beforeDown: beforeDownSpy })
      const refsToken = signRefs(
        { refs: { Organization: [{ id: 'org-1' }] }, testRunId: 'run-123', environment: '' },
        config.signingSecret,
      )
      const req = signedRequest(
        { action: 'down', refsToken },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      expect(beforeDownSpy).toHaveBeenCalledOnce()
      const [ctx] = beforeDownSpy.mock.calls[0]!
      expect(ctx.scenarioName).toBe('run-123')
      expect(ctx.refs).toBeDefined()
    })

    it('async afterUp hook is supported', async () => {
      const config = createConfig({
        afterUp: async (ctx: HookContext, auth: AuthResult): Promise<AuthResult> => ({
          ...auth,
          credentials: { asyncKey: 'asyncValue' },
        }),
      })
      const req = signedRequest(
        { action: 'up', create: { Organization: [{ name: 'Org' }] }, testRunId: 'run-123' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      const body = res.body as any
      expect(body.auth.credentials.asyncKey).toBe('asyncValue')
    })
  })

  describe('composite PK', () => {
    it('prefers field named "id" over first isId field in composite PKs', async () => {
      const queries: string[] = []
      let insertCounter = 0
      const executor: SQLExecutor & { queries: string[] } = {
        queries,
        async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
          queries.push(sql)
          const trimmed = sql.trim().toLowerCase()

          if (trimmed.includes('information_schema.tables') && !trimmed.includes('table_constraints'))
            return [{ table_name: 'organization' }, { table_name: 'member' }] as T[]
          if (trimmed.includes('information_schema.columns') && !trimmed.includes('table_constraints'))
            return [
              { table_name: 'organization', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: 'gen_random_uuid()' },
              { table_name: 'organization', column_name: 'name', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null },
              { table_name: 'member', column_name: 'organization_id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: null },
              { table_name: 'member', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: 'gen_random_uuid()' },
              { table_name: 'member', column_name: 'role', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null },
            ] as T[]
          if (trimmed.includes('foreign key'))
            return [
              { from_table: 'member', from_column: 'organization_id', to_table: 'organization', to_column: 'id', is_nullable: 'NO' },
            ] as T[]
          if (trimmed.includes('primary key'))
            return [
              { table_name: 'organization', column_name: 'id' },
              { table_name: 'member', column_name: 'organization_id' },
              { table_name: 'member', column_name: 'id' },
            ] as T[]
          if (trimmed.includes('pg_type')) return [] as T[]

          if (trimmed.startsWith('insert')) {
            const record: Record<string, unknown> = {}
            const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i)
            if (colMatch && params) {
              const cols = colMatch[1]!.split(',').map((c) => c.trim().replace(/"/g, ''))
              for (let i = 0; i < cols.length; i++) {
                record[cols[i]!] = params[i]
              }
            }
            if (!record.id) record.id = `mock-id-${insertCounter++}`
            return [record] as T[]
          }

          return [] as T[]
        },
        async transaction<T>(fn: (tx: SQLExecutor) => Promise<T>): Promise<T> {
          return fn(executor)
        },
      }

      const config: HandlerConfig = {
        executor,
        scopeField: 'organizationId',
        sharedSecret: 'test-secret',
        signingSecret: 'test-signing-secret',
        auth: async (user, _ctx) => ({ headers: { Authorization: 'Bearer token' } }),
      }

      const req = signedRequest(
        {
          action: 'up',
          create: {
            Organization: [{ name: 'Org' }],
            Member: [{ role: 'admin' }],
          },
          testRunId: 'run-composite',
        },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      const body = res.body as any
      expect(body.refs).toBeDefined()
      expect(body.refs.Member).toBeDefined()
      expect(body.refs.Member[0]).toBeDefined()

      const member = body.refs.Member[0]
      expect(member.id).toBeDefined()
      expect(typeof member.id).toBe('string')

      const memberInsert = queries.find((q) => q.toLowerCase().includes('insert') && q.toLowerCase().includes('member'))
      expect(memberInsert).toBeDefined()
      expect(memberInsert).toMatch(/"id"/)
    })
  })

  describe('factories', () => {
    it('uses factory create instead of SQL when factory is registered', async () => {
      const factoryCreateSpy = vi.fn(async (data: Record<string, unknown>, _ctx: FactoryContext) => ({
        id: 'factory-org-1',
        name: data.name,
      }))

      const executor = createMockExecutor()
      const config = createConfig({
        executor,
        factories: {
          Organization: defineFactory({ create: factoryCreateSpy }),
        },
      })

      const req = signedRequest(
        { action: 'up', create: { Organization: [{ name: 'FactoryOrg' }] }, testRunId: 'run-factory' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      expect(factoryCreateSpy).toHaveBeenCalledOnce()
      expect(factoryCreateSpy.mock.calls[0]![0]).toMatchObject({ name: 'FactoryOrg' })

      const body = res.body as any
      expect(body.refs.Organization[0].id).toBe('factory-org-1')

      // No INSERT query for Organization should have been issued
      const orgInserts = executor.queries.filter((q) => q.toLowerCase().includes('insert') && q.toLowerCase().includes('organization'))
      expect(orgInserts).toHaveLength(0)
    })

    it('hybrid mode: factory for some models, SQL for others', async () => {
      const factoryCreateSpy = vi.fn(async (data: Record<string, unknown>) => ({
        id: 'factory-org-1',
        name: data.name,
      }))

      const executor = createMockExecutor()
      const config = createConfig({
        executor,
        factories: {
          Organization: defineFactory({ create: factoryCreateSpy }),
          // User has no factory — falls back to SQL
        },
      })

      const req = signedRequest(
        {
          action: 'up',
          create: {
            Organization: [{ name: 'HybridOrg' }],
            User: [{ email: 'test@example.com', name: 'Test' }],
          },
          testRunId: 'run-hybrid',
        },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      expect(factoryCreateSpy).toHaveBeenCalledOnce()

      // User should have been created via SQL INSERT
      const userInserts = executor.queries.filter((q) => q.toLowerCase().includes('insert') && q.toLowerCase().includes('"user"'))
      expect(userInserts.length).toBeGreaterThan(0)
    })

    it('factory receives pre-resolved FK IDs (not temp IDs)', async () => {
      let receivedData: Record<string, unknown> | null = null

      const executor = createMockExecutor()
      const config = createConfig({
        executor,
        factories: {
          Organization: defineFactory({
            create: async (data) => ({ id: 'resolved-org-id', name: data.name }),
          }),
          User: defineFactory({
            create: async (data, _ctx) => {
              receivedData = { ...data }
              return { id: 'user-1', email: data.email, organizationId: data.organizationId }
            },
          }),
        },
      })

      // Nest User under Organization so tree resolver wires the FK
      const req = signedRequest(
        {
          action: 'up',
          create: {
            Organization: [{ name: 'Org', User: [{ email: 'a@b.com', name: 'A' }] }],
          },
          testRunId: 'run-fk',
        },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      // The User factory should receive the real org ID, not __temp_Organization_0
      expect(receivedData).toBeDefined()
      expect(receivedData!.organizationId).toBe('resolved-org-id')
    })

    it('errors when factory does not return PK field', async () => {
      const config = createConfig({
        factories: {
          Organization: defineFactory({
            create: async (data) => ({ name: data.name }), // missing 'id'
          }),
        },
      })

      const req = signedRequest(
        { action: 'up', create: { Organization: [{ name: 'NoPK' }] }, testRunId: 'run-nopk' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)

      expect(res.status).toBe(500)
      expect(res.body.code).toBe('FACTORY_MISSING_PK')
    })

    it('factory teardown is called per record in reverse order', async () => {
      const teardownCalls: string[] = []
      const config = createConfig({
        factories: {
          Organization: defineFactory({
            create: async (data) => ({ id: `org-${data.name}`, name: data.name }),
            teardown: async (record) => {
              teardownCalls.push(record.id as string)
            },
          }),
        },
      })

      // First create
      const upReq = signedRequest(
        {
          action: 'up',
          create: { Organization: [{ name: 'A' }, { name: 'B' }] },
          testRunId: 'run-teardown',
        },
        config.sharedSecret,
      )
      const upRes = await handleRequest(config, upReq)
      expect(upRes.status).toBe(200)
      const refsToken = (upRes.body as any).refsToken

      // Then teardown
      const downReq = signedRequest(
        { action: 'down', refsToken },
        config.sharedSecret,
      )
      const downRes = await handleRequest(config, downReq)

      expect(downRes.status).toBe(200)
      expect(teardownCalls).toHaveLength(2)
      // Reverse order: B first, then A
      expect(teardownCalls).toEqual(['org-B', 'org-A'])
    })

    it('SQL teardown is used when factory has no teardown defined', async () => {
      const executor = createMockExecutor()
      const config = createConfig({
        executor,
        factories: {
          Organization: defineFactory({
            create: async (data) => ({ id: 'org-1', name: data.name }),
            // No teardown — SQL DELETE should be used
          }),
        },
      })

      const upReq = signedRequest(
        { action: 'up', create: { Organization: [{ name: 'Org' }] }, testRunId: 'run-sql-td' },
        config.sharedSecret,
      )
      const upRes = await handleRequest(config, upReq)
      expect(upRes.status).toBe(200)

      const refsToken = (upRes.body as any).refsToken
      const downReq = signedRequest(
        { action: 'down', refsToken },
        config.sharedSecret,
      )
      const downRes = await handleRequest(config, downReq)

      expect(downRes.status).toBe(200)
      // SQL DELETE should have been used
      const deleteQueries = executor.queries.filter((q) => q.toLowerCase().includes('delete'))
      expect(deleteQueries.length).toBeGreaterThan(0)
    })

    it('factory context contains refs of previously created models', async () => {
      let userCtx: FactoryContext | null = null

      const config = createConfig({
        factories: {
          Organization: defineFactory({
            create: async (data) => ({ id: 'org-ctx', name: data.name }),
          }),
          User: defineFactory({
            create: async (data, ctx) => {
              userCtx = ctx
              return { id: 'user-ctx', email: data.email, organizationId: data.organizationId }
            },
          }),
        },
      })

      const req = signedRequest(
        {
          action: 'up',
          create: { Organization: [{ name: 'Org' }], User: [{ email: 'x@y.com', name: 'X' }] },
          testRunId: 'run-ctx',
        },
        config.sharedSecret,
      )
      await handleRequest(config, req)

      expect(userCtx).not.toBeNull()
      // By the time User factory runs, Organization should already be in refs
      expect(userCtx!.refs.Organization).toBeDefined()
      expect(userCtx!.refs.Organization).toHaveLength(1)
      expect(userCtx!.refs.Organization[0]!.id).toBe('org-ctx')
      expect(userCtx!.testRunId).toBe('run-ctx')
    })
  })

  describe('errors', () => {
    it('returns 400 for unknown action', async () => {
      const config = createConfig()
      const req = signedRequest({ action: 'invalid' }, config.sharedSecret)
      const res = await handleRequest(config, req)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('UNKNOWN_ACTION')
    })

    it('returns 400 for invalid JSON', async () => {
      const config = createConfig()
      const body = 'not json'
      const res = await handleRequest(config, {
        body,
        headers: { 'x-signature': signBody(body, config.sharedSecret) },
      })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('INVALID_BODY')
    })
  })
})
