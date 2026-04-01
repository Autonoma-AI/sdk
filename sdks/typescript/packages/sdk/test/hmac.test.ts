import { describe, it, expect } from 'vitest'
import { signBody, verifySignature } from '../src/hmac.js'

describe('HMAC', () => {
  const secret = 'test-secret-key'
  const body = '{"action":"discover"}'

  it('signs a body deterministically', () => {
    const sig1 = signBody(body, secret)
    const sig2 = signBody(body, secret)
    expect(sig1).toBe(sig2)
    expect(sig1).toMatch(/^[a-f0-9]{64}$/)
  })

  it('verifies a valid signature', () => {
    const sig = signBody(body, secret)
    expect(verifySignature(body, sig, secret)).toBe(true)
  })

  it('rejects an invalid signature', () => {
    expect(verifySignature(body, 'bad-signature', secret)).toBe(false)
  })

  it('rejects a signature with wrong secret', () => {
    const sig = signBody(body, secret)
    expect(verifySignature(body, sig, 'wrong-secret')).toBe(false)
  })

  it('rejects a signature for different body', () => {
    const sig = signBody(body, secret)
    expect(verifySignature('{"action":"up"}', sig, secret)).toBe(false)
  })
})
