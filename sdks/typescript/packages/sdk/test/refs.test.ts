import { describe, it, expect } from 'vitest'
import { signRefs, verifyRefs } from '../src/refs.js'

describe('Refs JWT', () => {
  const secret = 'test-secret-key'
  const payload = {
    refs: { user: [{ id: '1', email: 'test@example.com' }] },
    testRunId: 'run-123',
    environment: 'standard',
  }

  it('signs and verifies a refs token', () => {
    const token = signRefs(payload, secret)
    expect(token.split('.')).toHaveLength(3)

    const decoded = verifyRefs(token, secret)
    expect(decoded).toEqual(payload)
  })

  it('rejects a tampered token', () => {
    const token = signRefs(payload, secret)
    const parts = token.split('.')
    // Tamper with the payload
    parts[1] = Buffer.from('{"refs":{},"testRunId":"hacked","environment":"x"}').toString('base64url')
    const tampered = parts.join('.')

    expect(() => verifyRefs(tampered, secret)).toThrow('signature mismatch')
  })

  it('rejects a token with wrong secret', () => {
    const token = signRefs(payload, secret)
    expect(() => verifyRefs(token, 'wrong-secret')).toThrow('signature mismatch')
  })

  it('rejects a malformed token', () => {
    expect(() => verifyRefs('not.a.valid.token', secret)).toThrow()
    expect(() => verifyRefs('single', secret)).toThrow('malformed token')
  })
})
