import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { handleRequest } from '../src/handler.js'
import { signBody } from '../src/hmac.js'
import { signRefs } from '../src/refs.js'
import { defineFactory } from '../src/factory.js'
import type {
  AuthResult,
  FactoryContext,
  HandlerConfig,
  HookContext,
} from '../src/types.js'

function createConfig(overrides?: Partial<HandlerConfig>): HandlerConfig {
  return {
    scopeField: 'organizationId',
    sharedSecret: 'test-secret',
    signingSecret: 'test-signing-secret',
    auth: async (user) => ({ headers: { Authorization: `Bearer jwt-${user?.id ?? 'anon'}` } }),
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

const OrgInput = z.object({ name: z.string() })
const UserInput = z.object({
  email: z.string(),
  name: z.string(),
  organizationId: z.string(),
})

describe('handleRequest', () => {
  describe('environment gating', () => {
    it('returns 404 in production when not allowed', async () => {
      const original = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      try {
        const config = createConfig({
          factories: {
            Organization: defineFactory({
              create: async (data) => ({ id: 'o1', name: data.name }),
              inputSchema: OrgInput,
            }),
          },
        })
        const req = signedRequest({ action: 'discover' }, config.sharedSecret)
        const res = await handleRequest(config, req)
        expect(res.status).toBe(404)
        expect(res.body.code).toBe('PRODUCTION_BLOCKED')
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

    it('rejects identical shared and signing secrets', async () => {
      const config = createConfig({ sharedSecret: 'same', signingSecret: 'same' })
      const req = signedRequest({ action: 'discover' }, 'same')
      const res = await handleRequest(config, req)
      expect(res.status).toBe(500)
      expect(res.body.code).toBe('SAME_SECRETS')
    })
  })

  describe('discover', () => {
    it('returns an empty model list when no factories registered', async () => {
      const config = createConfig()
      const req = signedRequest({ action: 'discover' }, config.sharedSecret)
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      const body = res.body as Record<string, any>
      expect(body.schema.models).toHaveLength(0)
      expect(body.schema.edges).toEqual([])
      expect(body.schema.relations).toEqual([])
      expect(body.version).toBe('1.0')
      expect(body.sdk).toMatchObject({ language: 'typescript' })
    })

    it('builds schema from registered factory inputSchemas', async () => {
      const config = createConfig({
        factories: {
          Organization: defineFactory({
            create: async (data) => ({ id: 'o', name: data.name }),
            inputSchema: OrgInput,
          }),
          User: defineFactory({
            create: async (data) => ({
              id: 'u',
              email: data.email,
              name: data.name,
              organizationId: data.organizationId,
            }),
            inputSchema: UserInput,
          }),
        },
      })
      const req = signedRequest({ action: 'discover' }, config.sharedSecret)
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      const body = res.body as Record<string, any>
      const names = body.schema.models.map((m: any) => m.name).sort()
      expect(names).toEqual(['Organization', 'User'])
      const userModel = body.schema.models.find((m: any) => m.name === 'User')
      const fieldNames = userModel.fields.map((f: any) => f.name).sort()
      // includes synthetic id + email/name/organizationId
      expect(fieldNames).toEqual(['email', 'id', 'name', 'organizationId'])
    })
  })

  describe('up', () => {
    it('validates input via factory inputSchema and creates entities', async () => {
      const captured: Record<string, unknown> = {}
      const config = createConfig({
        factories: {
          Organization: defineFactory({
            create: async (data) => {
              captured.name = data.name
              return { id: 'org-1', name: data.name, organizationId: 'org-1' }
            },
            inputSchema: OrgInput,
          }),
        },
      })
      const req = signedRequest(
        { action: 'up', create: { Organization: [{ name: 'Acme' }] }, testRunId: 'run-123' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      expect(captured.name).toBe('Acme')
      const body = res.body as Record<string, any>
      expect(body.refs.Organization[0].id).toBe('org-1')
      expect(typeof body.refsToken).toBe('string')
    })

    it('resolves _alias / _ref to the real id', async () => {
      let receivedUser: Record<string, unknown> = {}
      const config = createConfig({
        factories: {
          Organization: defineFactory({
            create: async (data) => ({ id: 'org-real', name: data.name }),
            inputSchema: OrgInput,
          }),
          User: defineFactory({
            create: async (data) => {
              receivedUser = { ...data }
              return { id: 'user-1', email: data.email, name: data.name, organizationId: data.organizationId }
            },
            inputSchema: UserInput,
          }),
        },
      })
      const req = signedRequest(
        {
          action: 'up',
          create: {
            Organization: [{ _alias: 'org', name: 'Acme' }],
            User: [{ email: 'a@b.com', name: 'A', organizationId: { _ref: 'org' } }],
          },
          testRunId: 'run-ref',
        },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      expect(receivedUser.organizationId).toBe('org-real')
    })

    it('errors when factory does not return PK field', async () => {
      const config = createConfig({
        factories: {
          Organization: defineFactory({
            create: async (data) => ({ name: data.name }), // no id
            inputSchema: OrgInput,
          }),
        },
      })
      const req = signedRequest(
        { action: 'up', create: { Organization: [{ name: 'NoPK' }] }, testRunId: 'r' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)
      expect(res.status).toBe(500)
      expect(res.body.code).toBe('FACTORY_MISSING_PK')
    })

    it('returns 400 when create references an unregistered model', async () => {
      const config = createConfig({
        factories: {
          Organization: defineFactory({
            create: async (data) => ({ id: 'o', name: data.name }),
            inputSchema: OrgInput,
          }),
        },
      })
      const req = signedRequest(
        { action: 'up', create: { Mystery: [{ name: 'unknown' }] }, testRunId: 'r' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('INVALID_BODY')
    })

    it('returns 400 when payload references a missing alias', async () => {
      const config = createConfig({
        factories: {
          User: defineFactory({
            create: async (data) => ({
              id: 'u',
              email: data.email,
              name: data.name,
              organizationId: data.organizationId,
            }),
            inputSchema: UserInput,
          }),
        },
      })
      const req = signedRequest(
        {
          action: 'up',
          create: { User: [{ email: 'x@y.com', name: 'X', organizationId: { _ref: 'missing' } }] },
          testRunId: 'r',
        },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('INVALID_BODY')
    })

    it('substitutes {{testRunId}} tokens in input fields', async () => {
      let observedEmail: string | undefined
      const InputWithToken = z.object({ email: z.string() })
      const config = createConfig({
        factories: {
          User: defineFactory({
            create: async (data: { email: string }) => {
              observedEmail = data.email
              return { id: 'u-1', email: data.email }
            },
            inputSchema: InputWithToken,
          }),
        },
      })
      const req = signedRequest(
        { action: 'up', create: { User: [{ email: 'a-{{testRunId}}@x.com' }] }, testRunId: 'run-XYZ' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)
      expect(res.status).toBe(200)
      expect(observedEmail).toBe('a-run-XYZ@x.com')
    })
  })

  describe('down', () => {
    it('runs teardown in reverse order across models', async () => {
      const calls: string[] = []
      const config = createConfig({
        factories: {
          Organization: defineFactory({
            create: async (data) => ({ id: `org-${data.name}`, name: data.name }),
            teardown: async (record: { id: string }) => {
              calls.push(`org:${record.id}`)
            },
            inputSchema: OrgInput,
          }),
          User: defineFactory({
            create: async (data) => ({
              id: `user-${data.name}`,
              email: data.email,
              name: data.name,
              organizationId: data.organizationId,
            }),
            teardown: async (record: { id: string }) => {
              calls.push(`user:${record.id}`)
            },
            inputSchema: UserInput,
          }),
        },
      })

      const upReq = signedRequest(
        {
          action: 'up',
          create: {
            Organization: [{ _alias: 'o', name: 'A' }],
            User: [
              { email: 'u1@x.com', name: 'one', organizationId: { _ref: 'o' } },
              { email: 'u2@x.com', name: 'two', organizationId: { _ref: 'o' } },
            ],
          },
          testRunId: 'run-down',
        },
        config.sharedSecret,
      )
      const upRes = await handleRequest(config, upReq)
      expect(upRes.status).toBe(200)
      const refsToken = (upRes.body as Record<string, any>).refsToken

      const downReq = signedRequest({ action: 'down', refsToken }, config.sharedSecret)
      const downRes = await handleRequest(config, downReq)
      expect(downRes.status).toBe(200)
      // Users (children) torn down before Organization (parent), reverse insert per model.
      expect(calls).toEqual(['user:user-two', 'user:user-one', 'org:org-A'])
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

    it('skips models that have no factory teardown', async () => {
      const calls: string[] = []
      const config = createConfig({
        factories: {
          Organization: defineFactory({
            create: async (data) => ({ id: 'o-1', name: data.name }),
            // no teardown
            inputSchema: OrgInput,
          }),
        },
      })
      const refsToken = signRefs(
        { refs: { Organization: [{ id: 'o-1' }] }, testRunId: 'r', environment: '' },
        config.signingSecret,
      )
      const req = signedRequest({ action: 'down', refsToken }, config.sharedSecret)
      const res = await handleRequest(config, req)
      expect(res.status).toBe(200)
      expect(calls).toEqual([])
    })
  })

  describe('hooks', () => {
    it('afterUp hook runs and can modify auth result', async () => {
      const afterUpSpy = vi.fn(
        (_: HookContext, auth: AuthResult): AuthResult => ({
          ...auth,
          headers: { ...auth.headers, 'X-Custom': 'enriched' },
        }),
      )
      const config = createConfig({
        afterUp: afterUpSpy,
        factories: {
          Organization: defineFactory({
            create: async (data) => ({ id: 'o', name: data.name }),
            inputSchema: OrgInput,
          }),
        },
      })
      const req = signedRequest(
        { action: 'up', create: { Organization: [{ name: 'Org' }] }, testRunId: 'r' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)
      expect(res.status).toBe(200)
      expect(afterUpSpy).toHaveBeenCalledOnce()
      const body = res.body as Record<string, any>
      expect(body.auth.headers['X-Custom']).toBe('enriched')
    })

    it('beforeDown hook runs before teardown', async () => {
      const beforeDownSpy = vi.fn()
      const config = createConfig({
        beforeDown: beforeDownSpy,
        factories: {
          Organization: defineFactory({
            create: async (data) => ({ id: 'o-1', name: data.name }),
            teardown: async () => {},
            inputSchema: OrgInput,
          }),
        },
      })
      const refsToken = signRefs(
        { refs: { Organization: [{ id: 'o-1' }] }, testRunId: 'run', environment: '' },
        config.signingSecret,
      )
      const req = signedRequest({ action: 'down', refsToken }, config.sharedSecret)
      const res = await handleRequest(config, req)
      expect(res.status).toBe(200)
      expect(beforeDownSpy).toHaveBeenCalledOnce()
    })
  })

  describe('factory context', () => {
    it('passes refs of previously created models to factory create()', async () => {
      let userCtx: FactoryContext | null = null
      const config = createConfig({
        factories: {
          Organization: defineFactory({
            create: async (data) => ({ id: 'org-ctx', name: data.name }),
            inputSchema: OrgInput,
          }),
          User: defineFactory({
            create: async (data, ctx) => {
              userCtx = ctx
              return {
                id: 'user-ctx',
                email: data.email,
                name: data.name,
                organizationId: data.organizationId,
              }
            },
            inputSchema: UserInput,
          }),
        },
      })
      const req = signedRequest(
        {
          action: 'up',
          create: {
            Organization: [{ _alias: 'o', name: 'Org' }],
            User: [{ email: 'x@y.com', name: 'X', organizationId: { _ref: 'o' } }],
          },
          testRunId: 'run-ctx',
        },
        config.sharedSecret,
      )
      await handleRequest(config, req)
      expect(userCtx).not.toBeNull()
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
