import { describe, it, expect } from 'vitest'
import { resolveTokens } from '../src/handler'
import { AutonomaError } from '../src/errors'

describe('resolveTokens — defense-in-depth for recipe variables', () => {
  it('substitutes {{testRunId}}', () => {
    expect(resolveTokens({ email: 'alice-{{testRunId}}@test.local' }, 'run-123', 0))
      .toEqual({ email: 'alice-run-123@test.local' })
  })

  it('substitutes {{index}}', () => {
    expect(resolveTokens({ slot: 'pos-{{index}}' }, 'r', 4)).toEqual({ slot: 'pos-4' })
  })

  it('substitutes {{cycle(a,b)}} by index with wrap-around', () => {
    expect(resolveTokens('{{cycle(a,b)}}', 'r', 0)).toBe('a')
    expect(resolveTokens('{{cycle(a,b)}}', 'r', 1)).toBe('b')
    expect(resolveTokens('{{cycle(a,b)}}', 'r', 2)).toBe('a')
  })

  it('strips quotes from cycle values', () => {
    expect(resolveTokens("{{cycle('WEB','IOS','ANDROID')}}", 'r', 1)).toBe('IOS')
  })

  it('walks nested objects and arrays', () => {
    expect(
      resolveTokens(
        {
          users: [
            { email: 'u-{{testRunId}}@t.local' },
            { email: 'v-{{testRunId}}@t.local' },
          ],
          tags: ['{{testRunId}}-a', '{{testRunId}}-b'],
        },
        'xyz',
        0,
      ),
    ).toEqual({
      users: [{ email: 'u-xyz@t.local' }, { email: 'v-xyz@t.local' }],
      tags: ['xyz-a', 'xyz-b'],
    })
  })

  it('handles multiple tokens in one string', () => {
    expect(resolveTokens('{{testRunId}}-{{index}}', 'run', 7)).toBe('run-7')
  })

  it('throws UNRESOLVED_TOKEN for unknown tokens', () => {
    try {
      resolveTokens({ x: 'hello-{{mystery}}' }, 'r', 0)
      expect.fail('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(AutonomaError)
      expect((err as AutonomaError).code).toBe('UNRESOLVED_TOKEN')
      expect((err as Error).message).toContain('mystery')
    }
  })

  it('passes non-string primitives through unchanged', () => {
    expect(resolveTokens(42, 'r', 0)).toBe(42)
    expect(resolveTokens(true, 'r', 0)).toBe(true)
    expect(resolveTokens(null, 'r', 0)).toBeNull()
  })

  it('leaves strings without tokens unchanged', () => {
    expect(resolveTokens('plain string', 'r', 0)).toBe('plain string')
  })
})
