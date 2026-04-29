import { describe, it, expect } from 'vitest'

import { resolvePayloadTree, computeTeardownOrder } from '../src/payload-topo.js'
import { AutonomaError } from '../src/errors.js'

function modelsOf(tree: ReturnType<typeof resolvePayloadTree>): string[] {
  return tree.ops.map((op) => op.model)
}

describe('resolvePayloadTree', () => {
  it('orders dependents after aliased targets', () => {
    const tree = resolvePayloadTree({
      Org: [{ _alias: 'o', name: 'Acme' }],
      User: [
        { email: 'a@b.com', orgId: { _ref: 'o' } },
        { email: 'c@d.com', orgId: { _ref: 'o' } },
      ],
    })
    expect(modelsOf(tree)).toEqual(['Org', 'User', 'User'])
  })

  it('uses payload order as a stable tie-breaker', () => {
    const tree = resolvePayloadTree({
      User: [{ email: 'first@x.com', orgId: { _ref: 'o' } }],
      Org: [{ _alias: 'o', name: 'Acme' }],
    })
    expect(modelsOf(tree)).toEqual(['Org', 'User'])
  })

  it('treats nested {_ref:} as a dependency', () => {
    const tree = resolvePayloadTree({
      Org: [{ _alias: 'o', name: 'Acme' }],
      Settings: [
        {
          key: 'primary_org',
          value: { data: { orgId: { _ref: 'o' } } },
        },
      ],
    })
    expect(modelsOf(tree)).toEqual(['Org', 'Settings'])
  })

  it('rejects dangling _ref with INVALID_BODY', () => {
    expect(() =>
      resolvePayloadTree({ User: [{ email: 'x@y.com', orgId: { _ref: 'missing' } }] }),
    ).toThrow(AutonomaError)
    try {
      resolvePayloadTree({ User: [{ email: 'x@y.com', orgId: { _ref: 'missing' } }] })
    } catch (err) {
      expect((err as AutonomaError).code).toBe('INVALID_BODY')
    }
  })

  it('rejects duplicate _alias', () => {
    expect(() =>
      resolvePayloadTree({
        Org: [
          { _alias: 'o', name: 'A' },
          { _alias: 'o', name: 'B' },
        ],
      }),
    ).toThrow(AutonomaError)
  })

  it('rejects cycles', () => {
    expect(() =>
      resolvePayloadTree({
        A: [{ _alias: 'a', ref: { _ref: 'b' } }],
        B: [{ _alias: 'b', ref: { _ref: 'a' } }],
      }),
    ).toThrow(/cycle/i)
  })

  it('records aliases and owner models', () => {
    const tree = resolvePayloadTree({ Org: [{ _alias: 'o', name: 'Acme' }] })
    expect(tree.aliases.o).toBeDefined()
    expect(tree.aliasOwnerModel.o).toBe('Org')
  })

  it('treats self-reference as a no-op for ordering', () => {
    const tree = resolvePayloadTree({
      Org: [{ _alias: 'o', parent: { _ref: 'o' }, name: 'Acme' }],
    })
    expect(modelsOf(tree)).toEqual(['Org'])
  })

  it('rewrites _ref to a temp id in the cleaned fields', () => {
    const tree = resolvePayloadTree({
      Org: [{ _alias: 'o', name: 'Acme' }],
      User: [{ email: 'a@b.com', orgId: { _ref: 'o' } }],
    })
    const userOp = tree.ops.find((op) => op.model === 'User')!
    expect(typeof userOp.fields.orgId).toBe('string')
    expect((userOp.fields.orgId as string).startsWith('__temp_Org_')).toBe(true)
  })
})

describe('computeTeardownOrder', () => {
  it('uses alias dependencies when provided', () => {
    const order = computeTeardownOrder(
      { Org: [{ id: 'o-1' }], User: [{ id: 'u-1' }] },
      { o: [], u: ['o'] },
      { o: 'Org', u: 'User' },
    )
    expect(order).toEqual(['User', 'Org'])
  })

  it('falls back to reverse refs-key order without alias info', () => {
    const order = computeTeardownOrder({ Org: [], User: [], Note: [] })
    expect(order).toEqual(['Note', 'User', 'Org'])
  })
})
