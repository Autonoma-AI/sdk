import { describe, it, expect } from 'vitest'
import { fingerprint } from '../src/fingerprint.js'

describe('fingerprint', () => {
  it('produces a 16-char hex string', () => {
    const fp = fingerprint({ name: 'test' })
    expect(fp).toMatch(/^[a-f0-9]{16}$/)
  })

  it('is deterministic', () => {
    const data = { foo: 'bar', baz: [1, 2, 3] }
    expect(fingerprint(data)).toBe(fingerprint(data))
  })

  it('is order-independent for object keys', () => {
    const a = { z: 1, a: 2, m: 3 }
    const b = { a: 2, m: 3, z: 1 }
    expect(fingerprint(a)).toBe(fingerprint(b))
  })

  it('produces different fingerprints for different data', () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }))
  })

  it('handles nested objects with stable key ordering', () => {
    const a = { outer: { z: 1, a: 2 } }
    const b = { outer: { a: 2, z: 1 } }
    expect(fingerprint(a)).toBe(fingerprint(b))
  })
})
