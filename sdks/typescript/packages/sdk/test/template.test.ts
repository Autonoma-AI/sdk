import { describe, it, expect } from 'vitest'
import { resolveTemplate, type TemplateContext } from '../src/template.js'

describe('template engine', () => {
  const ctx: TemplateContext = {
    testRunId: 'run-abc123',
    index: 2,
  }

  it('resolves testRunId', () => {
    expect(resolveTemplate('{{testRunId}}', ctx)).toBe('run-abc123')
  })

  it('resolves index and index1', () => {
    expect(resolveTemplate('{{index}}', ctx)).toBe(2)
    expect(resolveTemplate('{{index1}}', ctx)).toBe(3)
  })

  it('interpolates in strings', () => {
    expect(resolveTemplate('admin-{{testRunId}}@autonoma.dev', ctx)).toBe(
      'admin-run-abc123@autonoma.dev',
    )
  })

  it('resolves cycle', () => {
    const items = ["'active'", "'active'", "'draft'"]
    const expr = `{{cycle([${items.join(',')}])}}`
    // index=2 → 2 % 3 = 2 → 'draft'
    expect(resolveTemplate(expr, ctx)).toBe('draft')
  })

  it('resolves nested objects', () => {
    const input = {
      name: 'User {{index1}}',
      runId: '{{testRunId}}',
    }
    const result = resolveTemplate(input, ctx) as Record<string, unknown>
    expect(result.name).toBe('User 3')
    expect(result.runId).toBe('run-abc123')
  })

  it('resolves arrays', () => {
    const input = ['{{testRunId}}', '{{index}}']
    const result = resolveTemplate(input, ctx)
    expect(result).toEqual(['run-abc123', 2])
  })

  it('passes through non-template values', () => {
    expect(resolveTemplate(42, ctx)).toBe(42)
    expect(resolveTemplate(null, ctx)).toBe(null)
    expect(resolveTemplate(true, ctx)).toBe(true)
  })

  it('resolves now() as ISO string', () => {
    const result = resolveTemplate('{{now()}}', ctx)
    expect(typeof result).toBe('string')
    expect(() => new Date(result as string)).not.toThrow()
  })

  it('throws on unknown expression', () => {
    expect(() => resolveTemplate('{{unknown}}', ctx)).toThrow('unknown expression')
  })
})
