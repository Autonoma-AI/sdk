import { describe, it, expect } from 'vitest'
import { handleRequest } from '../src/handler.js'
import { signBody } from '../src/hmac.js'
import { signRefs } from '../src/refs.js'
import { defineScenario } from '../src/scenario.js'
import type { HandlerConfig } from '../src/types.js'

function createConfig(overrides?: Partial<HandlerConfig>): HandlerConfig {
  return {
    sharedSecret: 'test-secret',
    signingSecret: 'test-signing-secret',
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

const singleUser = defineScenario({
  name: 'single-user',
  description: 'One user in a fresh org',
  up: async ({ testRunId }) => ({
    auth: { headers: { Authorization: `Bearer jwt-${testRunId}` } },
    teardown: { userId: `user-${testRunId}` },
  }),
})

describe('handleRequest (v2)', () => {
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
    it('returns an empty scenario list when none registered', async () => {
      const config = createConfig()
      const req = signedRequest({ action: 'discover' }, config.sharedSecret)
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      const body = res.body as Record<string, any>
      expect(body.scenarios).toEqual([])
      expect(body.version).toBe('2.0')
    })

    it('lists registered scenarios as { name, description }', async () => {
      const config = createConfig({
        scenarios: [
          singleUser,
          defineScenario({ name: 'empty', description: 'Nothing seeded', up: () => ({}) }),
        ],
      })
      const req = signedRequest({ action: 'discover' }, config.sharedSecret)
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      const body = res.body as Record<string, any>
      expect(body.scenarios).toEqual([
        { name: 'single-user', description: 'One user in a fresh org' },
        { name: 'empty', description: 'Nothing seeded' },
      ])
      // The factory-derived model schema is gone.
      expect(body.schema).toBeUndefined()
    })
  })

  describe('up', () => {
    it('runs the scenario up and returns auth, teardownToken, expiry', async () => {
      const config = createConfig({ scenarios: [singleUser] })
      const req = signedRequest(
        { action: 'up', scenario: { name: 'single-user' }, testRunId: 'run-123' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)

      expect(res.status).toBe(200)
      const body = res.body as Record<string, any>
      expect(body.version).toBe('2.0')
      expect(body.auth.headers.Authorization).toBe('Bearer jwt-run-123')
      expect(typeof body.teardownToken).toBe('string')
      // The duplicated plaintext refs and the old refsToken field are gone.
      expect(body.refs).toBeUndefined()
      expect(body.refsToken).toBeUndefined()
      expect(body.expiresInSeconds).toBe(3600)
    })

    it('applies a configured default expiry', async () => {
      const config = createConfig({ scenarios: [singleUser], expiresInSeconds: 900 })
      const req = signedRequest(
        { action: 'up', scenario: { name: 'single-user' }, testRunId: 'r' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)
      expect((res.body as Record<string, any>).expiresInSeconds).toBe(900)
    })

    it('omits auth when the scenario returns none', async () => {
      const config = createConfig({
        scenarios: [defineScenario({ name: 'bare', description: 'x', up: () => ({}) })],
      })
      const req = signedRequest(
        { action: 'up', scenario: { name: 'bare' }, testRunId: 'r' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)
      expect(res.status).toBe(200)
      const body = res.body as Record<string, any>
      expect(body.auth).toBeUndefined()
      expect(typeof body.teardownToken).toBe('string')
    })

    it('throws UNKNOWN_ENVIRONMENT for an unregistered scenario name', async () => {
      const config = createConfig({ scenarios: [singleUser] })
      const req = signedRequest(
        { action: 'up', scenario: { name: 'does-not-exist' }, testRunId: 'r' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('UNKNOWN_ENVIRONMENT')
    })

    it('returns 400 when scenario.name is missing', async () => {
      const config = createConfig({ scenarios: [singleUser] })
      const req = signedRequest({ action: 'up', testRunId: 'r' }, config.sharedSecret)
      const res = await handleRequest(config, req)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('INVALID_BODY')
    })
  })

  describe('down', () => {
    it('routes to the scenario down with the teardown handle from the token', async () => {
      const captured: { name?: string; teardown?: unknown; testRunId?: string } = {}
      const scenario = defineScenario({
        name: 'teardownable',
        description: 'x',
        up: async ({ testRunId }) => ({ teardown: { handle: `h-${testRunId}` } }),
        down: async ({ name, teardown, testRunId }) => {
          captured.name = name
          captured.teardown = teardown
          captured.testRunId = testRunId
        },
      })
      const config = createConfig({ scenarios: [scenario] })

      const upRes = await handleRequest(
        config,
        signedRequest(
          { action: 'up', scenario: { name: 'teardownable' }, testRunId: 'run-x' },
          config.sharedSecret,
        ),
      )
      const teardownToken = (upRes.body as Record<string, any>).teardownToken

      const downRes = await handleRequest(
        config,
        signedRequest(
          { action: 'down', teardownToken, testRunId: 'run-x' },
          config.sharedSecret,
        ),
      )
      expect(downRes.status).toBe(200)
      expect((downRes.body as Record<string, any>).ok).toBe(true)
      expect(captured.name).toBe('teardownable')
      expect(captured.teardown).toEqual({ handle: 'h-run-x' })
      expect(captured.testRunId).toBe('run-x')
    })

    it('recovers the scenario name from the token when the request omits it', async () => {
      let downRan = false
      const scenario = defineScenario({
        name: 'from-token',
        description: 'x',
        up: () => ({ teardown: {} }),
        down: () => {
          downRan = true
        },
      })
      const config = createConfig({ scenarios: [scenario] })
      const teardownToken = signRefs(
        { refs: {}, testRunId: 'r', environment: 'from-token' },
        config.signingSecret,
      )
      const res = await handleRequest(
        config,
        signedRequest({ action: 'down', teardownToken }, config.sharedSecret),
      )
      expect(res.status).toBe(200)
      expect(downRan).toBe(true)
    })

    it('no-ops when the scenario defines no down', async () => {
      const scenario = defineScenario({
        name: 'no-down',
        description: 'x',
        up: () => ({ teardown: {} }),
      })
      const config = createConfig({ scenarios: [scenario] })
      const teardownToken = signRefs(
        { refs: {}, testRunId: 'r', environment: 'no-down' },
        config.signingSecret,
      )
      const res = await handleRequest(
        config,
        signedRequest({ action: 'down', teardownToken }, config.sharedSecret),
      )
      expect(res.status).toBe(200)
      expect((res.body as Record<string, any>).ok).toBe(true)
    })

    it('rejects a tampered teardownToken', async () => {
      const config = createConfig()
      const req = signedRequest(
        { action: 'down', teardownToken: 'bad.token.here' },
        config.sharedSecret,
      )
      const res = await handleRequest(config, req)
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('INVALID_TEARDOWN_TOKEN')
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
