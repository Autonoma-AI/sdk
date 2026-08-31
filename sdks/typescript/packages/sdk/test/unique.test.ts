import { describe, it, expect } from 'vitest'
import { uniqueToken, uniqueId, uniqueSlug, uniqueEmail } from '../src/unique.js'

describe('uniqueness helpers', () => {
  it('are deterministic per (testRunId, inputs)', () => {
    expect(uniqueToken('run-1', 'a')).toBe(uniqueToken('run-1', 'a'))
    expect(uniqueEmail('run-1')).toBe(uniqueEmail('run-1'))
    expect(uniqueSlug('run-1', 'Acme Inc')).toBe(uniqueSlug('run-1', 'Acme Inc'))
    expect(uniqueId('run-1', 'user')).toBe(uniqueId('run-1', 'user'))
  })

  it('differ across testRunIds', () => {
    expect(uniqueToken('run-1', 'a')).not.toBe(uniqueToken('run-2', 'a'))
    expect(uniqueEmail('run-1')).not.toBe(uniqueEmail('run-2'))
  })

  it('differ across inputs within a run', () => {
    expect(uniqueToken('run-1', 'a')).not.toBe(uniqueToken('run-1', 'b'))
  })

  it('produce well-shaped values', () => {
    expect(uniqueEmail('r', { local: 'qa', domain: 'test.dev' })).toMatch(
      /^qa\+[a-f0-9]{12}@test\.dev$/,
    )
    expect(uniqueSlug('r', 'Acme Inc!')).toMatch(/^acme-inc-[a-f0-9]{12}$/)
    expect(uniqueId('r', 'org')).toMatch(/^org_[a-f0-9]{12}$/)
  })

  // Pin the exact digest so a separator regression (e.g. a stray NUL instead of
  // the documented space) fails loudly. These are sha256(testRunId + " " +
  // parts...) sliced to 12 hex and must be byte-identical across every SDK.
  it('match the documented cross-language digest vectors', () => {
    expect(uniqueToken('run-1', 'a')).toBe('549f29f78d6d')
    expect(uniqueToken('run-1')).toBe('4e65d3fbe8ad')
    expect(uniqueId('run-1')).toBe('id_9e2910a10d4d')
    expect(uniqueEmail('run-1')).toBe('user+039af36014b8@example.com')
  })
})
