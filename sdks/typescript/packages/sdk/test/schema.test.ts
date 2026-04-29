import { describe, it, expect } from 'vitest'
import { z } from 'zod'

import { defineFactory } from '../src/factory.js'
import {
  buildSchemaFromFactories,
  fieldTypeFromZod,
  schemaToWire,
} from '../src/schema.js'

describe('fieldTypeFromZod', () => {
  it.each([
    [z.string(), 'string'],
    [z.string().email(), 'string'],
    [z.number(), 'number'],
    [z.boolean(), 'boolean'],
    [z.bigint(), 'integer'],
    [z.date(), 'timestamp'],
    [z.string().optional(), 'string'],
    [z.string().nullable(), 'string'],
    [z.string().default('x'), 'string'],
    [z.array(z.string()), 'json'],
    [z.object({ a: z.string() }), 'json'],
    [z.record(z.string(), z.string()), 'json'],
    [z.enum(['a', 'b']), 'string'],
  ])('maps %#', (schema, expected) => {
    expect(fieldTypeFromZod(schema)).toBe(expected)
  })
})

describe('buildSchemaFromFactories', () => {
  const OrgInput = z.object({ name: z.string(), slug: z.string().optional() })
  const UserInput = z.object({
    email: z.string(),
    name: z.string(),
    organizationId: z.string(),
    age: z.number().default(18),
  })

  it('emits one model per factory and preserves scopeField', () => {
    const factories = {
      Organization: defineFactory({
        create: async (data) => ({ id: 'o', name: data.name }),
        inputSchema: OrgInput,
      }),
      User: defineFactory({
        create: async (data) => ({
          id: 'u',
          email: data.email,
          name: data.name,
          organizationId: data.organizationId,
          age: data.age,
        }),
        inputSchema: UserInput,
      }),
    }
    const schema = buildSchemaFromFactories(factories, 'organizationId')
    const names = schema.models.map((m) => m.name)
    expect(names).toEqual(['Organization', 'User'])
    expect(schema.scopeField).toBe('organizationId')
    expect(schema.edges).toEqual([])
    expect(schema.relations).toEqual([])
  })

  it('places a synthetic id field at the head of every model', () => {
    const schema = buildSchemaFromFactories(
      {
        Organization: defineFactory({
          create: async (data) => ({ id: 'o', name: data.name }),
          inputSchema: OrgInput,
        }),
      },
      'organizationId',
    )
    const fields = schema.models[0]!.fields
    expect(fields[0]!.name).toBe('id')
    expect(fields[0]!.isId).toBe(true)
    expect(fields[0]!.hasDefault).toBe(true)
  })

  it('propagates Zod field optionality and defaults', () => {
    const schema = buildSchemaFromFactories(
      {
        User: defineFactory({
          create: async (data) => ({
            id: 'u',
            email: data.email,
            name: data.name,
            organizationId: data.organizationId,
            age: data.age,
          }),
          inputSchema: UserInput,
        }),
      },
      'organizationId',
    )
    const byName = Object.fromEntries(schema.models[0]!.fields.map((f) => [f.name, f]))
    expect(byName.email!.type).toBe('string')
    expect(byName.email!.isRequired).toBe(true)
    expect(byName.age!.type).toBe('number')
    expect(byName.age!.isRequired).toBe(false)
    expect(byName.age!.hasDefault).toBe(true)
  })

  it('snake_cases tableName from PascalCase factory keys', () => {
    const schema = buildSchemaFromFactories(
      {
        OrgMember: defineFactory({
          create: async (data) => ({ id: 'm', name: data.name }),
          inputSchema: OrgInput,
        }),
      },
      'organizationId',
    )
    expect(schema.models[0]!.tableName).toBe('org_member')
  })

  it('serialises wire shape with camelCase keys', () => {
    const schema = buildSchemaFromFactories(
      {
        Organization: defineFactory({
          create: async (data) => ({ id: 'o', name: data.name }),
          inputSchema: OrgInput,
        }),
      },
      'organizationId',
    )
    const wire = schemaToWire(schema)
    const field0 = (wire.models as any[])[0].fields[0]
    expect(field0.isRequired).toBeDefined()
    expect(field0.isId).toBeDefined()
    expect(field0.hasDefault).toBeDefined()
    expect((wire.models as any[])[0].tableName).toBeDefined()
    expect((wire as any).scopeField).toBeDefined()
  })
})

describe('defineFactory validation', () => {
  it('requires inputSchema', () => {
    expect(() =>
      // @ts-expect-error — exercising the runtime check
      defineFactory({ create: async () => ({ id: 'x' }) }),
    ).toThrow(/inputSchema/)
  })

  it('rejects non-Zod inputSchema', () => {
    expect(() =>
      // @ts-expect-error — exercising the runtime check
      defineFactory({ create: async () => ({ id: 'x' }), inputSchema: {} }),
    ).toThrow(/inputSchema/)
  })

  it('rejects non-Zod refSchema', () => {
    expect(() =>
      defineFactory({
        create: async () => ({ id: 'x' }),
        inputSchema: z.object({}),
        // @ts-expect-error — exercising the runtime check
        refSchema: {},
      }),
    ).toThrow(/refSchema/)
  })
})
