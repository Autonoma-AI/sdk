import { describe, it, expect, vi } from 'vitest'
import { handleRequest } from '../src/handler.js'
import { signBody } from '../src/hmac.js'
import { signRefs } from '../src/refs.js'
import type { HandlerConfig, OrmAdapter, SchemaInfo } from '../src/types.js'

function createMockAdapter(overrides?: Partial<OrmAdapter>): OrmAdapter {
  return {
    getSchema: () => ({
      models: [
        { name: 'Organization', fields: [{ name: 'id', type: 'String', isRequired: true, isId: true, hasDefault: true }] },
        { name: 'User', fields: [{ name: 'id', type: 'String', isRequired: true, isId: true, hasDefault: true }] },
      ],
      edges: [
        { from: 'User', to: 'Organization', localField: 'organizationId', foreignField: 'id', nullable: false },
      ],
      relations: [],
      scopeField: 'testRunId',
    }),
    createEntities: vi.fn().mockImplementation(async (spec) => {
      const results: Record<string, any[]> = {}
      for (const [model, entitySpec] of Object.entries(spec)) {
        results[model] = (entitySpec as any).fields.map((f: any, i: number) => ({
          id: `${model}-${i}`,
          ...f,
        }))
      }
      return results
    }),
    teardown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function createConfig(overrides?: Partial<HandlerConfig>): HandlerConfig {
  return {
    adapter: createMockAdapter(),
    sharedSecret: 'test-secret',
    signingSecret: 'test-signing-secret',
    auth: async (user) => ({ token: 'jwt-token', userId: user.id }),
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
    it('returns schema', async () => {
      const config = createConfig()
      const req = signedRequest({ action: 'discover' }, config.sharedSecret)
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      const body = res.body as any
      expect(body.schema).toBeDefined()
      expect(body.version).toBe('1.0')
      expect(body.sdk).toMatchObject({ language: 'typescript' })
    })
  })

  describe('up', () => {
    it('creates entities and returns auth + refs + refsToken', async () => {
      const config = createConfig()
      const req = signedRequest(
        { action: 'up', create: { Organization: [{ name: 'Org' }], User: [{ email: 'test@test.com', name: 'Test' }] }, testRunId: 'run-123' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      const body = res.body as any
      expect(body.auth.token).toBe('jwt-token')
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
      expect(config.adapter.teardown).toHaveBeenCalledWith('run-123', {})
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
