import { describe, it, expect } from 'vitest'
import { introspectPrisma } from '../src/introspect.js'
import dmmf from '../../../fixtures/dmmf.json'

function createMockPrisma(models: Record<string, any>) {
  return { _runtimeDataModel: { models } }
}

describe('introspectPrisma', () => {
  it('extracts models from DMMF', () => {
    const prisma = createMockPrisma(dmmf.models)
    const schema = introspectPrisma(prisma, { scopeField: 'testRunId' })

    expect(schema.models).toHaveLength(4)
    expect(schema.models.map((m) => m.name).sort()).toEqual([
      'Category',
      'Organization',
      'Product',
      'User',
    ])
  })

  it('extracts FK edges', () => {
    const prisma = createMockPrisma(dmmf.models)
    const schema = introspectPrisma(prisma, { scopeField: 'testRunId' })

    const userToOrg = schema.edges.find(
      (e) => e.from === 'User' && e.to === 'Organization',
    )
    expect(userToOrg).toBeDefined()
    expect(userToOrg!.localField).toBe('organizationId')
    expect(userToOrg!.foreignField).toBe('id')
    expect(userToOrg!.nullable).toBe(false)
  })

  it('detects self-referential edges', () => {
    const prisma = createMockPrisma(dmmf.models)
    const schema = introspectPrisma(prisma, { scopeField: 'testRunId' })

    const selfRef = schema.edges.find(
      (e) => e.from === 'Category' && e.to === 'Category',
    )
    expect(selfRef).toBeDefined()
    expect(selfRef!.localField).toBe('parentId')
    expect(selfRef!.nullable).toBe(true)
  })

  it('sets scopeField from config', () => {
    const prisma = createMockPrisma(dmmf.models)
    const schema = introspectPrisma(prisma, { scopeField: 'organizationId' })
    expect(schema.scopeField).toBe('organizationId')
  })

  it('extracts scalar and enum fields (not relations)', () => {
    const prisma = createMockPrisma(dmmf.models)
    const schema = introspectPrisma(prisma, { scopeField: 'testRunId' })

    const user = schema.models.find((m) => m.name === 'User')!
    const fieldNames = user.fields.map((f) => f.name)
    expect(fieldNames).toContain('email')
    expect(fieldNames).toContain('role')
    expect(fieldNames).not.toContain('organization') // relation, not scalar
  })

  it('throws when DMMF is unavailable', () => {
    expect(() =>
      introspectPrisma({}, { scopeField: 'testRunId' }),
    ).toThrow('Cannot introspect Prisma schema')
  })
})
