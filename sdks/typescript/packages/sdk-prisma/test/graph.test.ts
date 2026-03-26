import { describe, it, expect } from 'vitest'
import { topoSort, findDeferrableEdge } from '@autonoma-ai/sdk'
import { introspectPrisma } from '../src/introspect.js'
import dmmf from '../../../fixtures/dmmf.json'

describe('graph with Prisma schema', () => {
  it('sorts entity creation in FK order', () => {
    const prisma = { _runtimeDataModel: { models: dmmf.models } }
    const schema = introspectPrisma(prisma, { scopeField: 'testRunId' })

    const entityModels = ['Organization', 'User', 'Product']
    const { sorted, cycles } = topoSort(entityModels, schema.edges)

    expect(cycles).toEqual([])
    expect(sorted.indexOf('Organization')).toBeLessThan(sorted.indexOf('User'))
    // Product has no FKs, can be anywhere
    expect(sorted).toContain('Product')
  })
})
