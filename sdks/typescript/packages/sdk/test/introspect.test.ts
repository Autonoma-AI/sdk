import { describe, it, expect } from 'vitest'
import { introspectDatabase } from '../src/introspect'
import { getDialect } from '../src/dialect'
import type { SQLExecutor } from '../src/types'

function createMockExecutor(
  tables: Record<string, unknown>[],
  columns: Record<string, unknown>[],
  pks: Record<string, unknown>[],
  fks: Record<string, unknown>[],
  enums: Record<string, unknown>[] = [],
): SQLExecutor {
  return {
    async query<T>(sql: string): Promise<T[]> {
      const s = sql.trim().toLowerCase()
      if (s.includes('foreign key') || s.includes('referenced_table_name')) return fks as T[]
      if (s.includes('primary key')) return pks as T[]
      if (s.includes('information_schema.tables') && !s.includes('table_constraints')) return tables as T[]
      if (s.includes('information_schema.columns') && !s.includes('table_constraints')) return columns as T[]
      if (s.includes('pg_type') || s.includes('1 = 0')) return enums as T[]
      return [] as T[]
    },
    async transaction<T>(fn: (tx: SQLExecutor) => Promise<T>): Promise<T> {
      return fn(this)
    },
  }
}

describe('introspectDatabase — postgres', () => {
  const dialect = getDialect('postgres')

  it('builds models with PascalCase names from snake_case tables', async () => {
    const exec = createMockExecutor(
      [{ table_name: 'user_account' }, { table_name: 'organization' }],
      [
        { table_name: 'user_account', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: 'gen_random_uuid()' },
        { table_name: 'user_account', column_name: 'full_name', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null },
        { table_name: 'organization', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: 'gen_random_uuid()' },
      ],
      [
        { table_name: 'user_account', column_name: 'id' },
        { table_name: 'organization', column_name: 'id' },
      ],
      [],
    )

    const result = await introspectDatabase(exec, dialect, { scopeField: 'organizationId' })

    expect(result.schema.models.map((m) => m.name).sort()).toEqual(['Organization', 'UserAccount'])
    const ua = result.schema.models.find((m) => m.name === 'UserAccount')!
    expect(ua.fields.map((f) => f.name)).toEqual(['id', 'fullName'])
    expect(result.tableMap.get('UserAccount')).toBe('user_account')
    expect(result.columnMaps.get('UserAccount')!.get('fullName')).toBe('full_name')
  })

  it('builds FK edges', async () => {
    const exec = createMockExecutor(
      [{ table_name: 'user' }, { table_name: 'organization' }],
      [
        { table_name: 'user', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: 'x' },
        { table_name: 'user', column_name: 'organization_id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: null },
        { table_name: 'organization', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: 'x' },
      ],
      [
        { table_name: 'user', column_name: 'id' },
        { table_name: 'organization', column_name: 'id' },
      ],
      [{ from_table: 'user', from_column: 'organization_id', to_table: 'organization', to_column: 'id', is_nullable: 'NO' }],
    )

    const result = await introspectDatabase(exec, dialect, { scopeField: 'organizationId' })

    expect(result.schema.edges).toHaveLength(1)
    expect(result.schema.edges[0]).toEqual({
      from: 'User',
      to: 'Organization',
      localField: 'organizationId',
      foreignField: 'id',
      nullable: false,
    })
  })

  it('resolves postgres enums', async () => {
    const exec = createMockExecutor(
      [{ table_name: 'app' }],
      [
        { table_name: 'app', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: 'x' },
        { table_name: 'app', column_name: 'arch', data_type: 'USER-DEFINED', udt_name: 'architecture', is_nullable: 'NO', column_default: null },
      ],
      [{ table_name: 'app', column_name: 'id' }],
      [],
      [
        { enum_name: 'architecture', enum_value: 'WEB' },
        { enum_name: 'architecture', enum_value: 'IOS' },
        { enum_name: 'architecture', enum_value: 'ANDROID' },
      ],
    )

    const result = await introspectDatabase(exec, dialect, { scopeField: 'orgId' })

    const archField = result.schema.models[0]!.fields.find((f) => f.name === 'arch')!
    expect(archField.type).toBe('enum(WEB,IOS,ANDROID)')
  })

  it('excludes _prisma_migrations by default', async () => {
    const exec = createMockExecutor(
      [{ table_name: 'user' }, { table_name: '_prisma_migrations' }],
      [
        { table_name: 'user', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: 'x' },
      ],
      [{ table_name: 'user', column_name: 'id' }],
      [],
    )

    const result = await introspectDatabase(exec, dialect, { scopeField: 'orgId' })
    expect(result.schema.models).toHaveLength(1)
    expect(result.schema.models[0]!.name).toBe('User')
  })

  it('respects custom tableNameMap', async () => {
    const exec = createMockExecutor(
      [{ table_name: 'usr' }],
      [{ table_name: 'usr', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: 'x' }],
      [{ table_name: 'usr', column_name: 'id' }],
      [],
    )

    const result = await introspectDatabase(exec, dialect, {
      scopeField: 'orgId',
      tableNameMap: { User: 'usr' },
    })

    expect(result.schema.models[0]!.name).toBe('User')
    expect(result.tableMap.get('User')).toBe('usr')
  })
})

describe('introspectDatabase — mysql', () => {
  const dialect = getDialect('mysql')

  it('parses inline MySQL enum values from column_type', async () => {
    const exec = createMockExecutor(
      [{ table_name: 'app' }],
      [
        { table_name: 'app', column_name: 'id', data_type: 'int', udt_name: 'int', is_nullable: 'NO', column_default: null },
        { table_name: 'app', column_name: 'architecture', data_type: 'enum', udt_name: "enum('WEB','ANDROID','IOS')", is_nullable: 'NO', column_default: null },
      ],
      [{ table_name: 'app', column_name: 'id' }],
      [],
    )

    const result = await introspectDatabase(exec, dialect, { scopeField: 'orgId', schema: 'mydb' })

    const archField = result.schema.models[0]!.fields.find((f) => f.name === 'architecture')!
    expect(archField.type).toBe('enum(WEB,ANDROID,IOS)')
  })

  it('maps MySQL data types correctly', async () => {
    const exec = createMockExecutor(
      [{ table_name: 'example' }],
      [
        { table_name: 'example', column_name: 'id', data_type: 'int', udt_name: 'int', is_nullable: 'NO', column_default: null },
        { table_name: 'example', column_name: 'name', data_type: 'varchar', udt_name: 'varchar(255)', is_nullable: 'YES', column_default: null },
        { table_name: 'example', column_name: 'amount', data_type: 'decimal', udt_name: 'decimal(10,2)', is_nullable: 'NO', column_default: null },
        { table_name: 'example', column_name: 'is_active', data_type: 'tinyint(1)', udt_name: 'tinyint(1)', is_nullable: 'NO', column_default: '0' },
        { table_name: 'example', column_name: 'created_at', data_type: 'datetime', udt_name: 'datetime', is_nullable: 'NO', column_default: null },
        { table_name: 'example', column_name: 'data', data_type: 'json', udt_name: 'json', is_nullable: 'YES', column_default: null },
        { table_name: 'example', column_name: 'content', data_type: 'mediumtext', udt_name: 'mediumtext', is_nullable: 'YES', column_default: null },
        { table_name: 'example', column_name: 'avatar', data_type: 'blob', udt_name: 'blob', is_nullable: 'YES', column_default: null },
      ],
      [{ table_name: 'example', column_name: 'id' }],
      [],
    )

    const result = await introspectDatabase(exec, dialect, { scopeField: 'orgId', schema: 'mydb' })
    const fields = result.schema.models[0]!.fields

    expect(fields.find((f) => f.name === 'id')!.type).toBe('Int')
    expect(fields.find((f) => f.name === 'name')!.type).toBe('String')
    expect(fields.find((f) => f.name === 'amount')!.type).toBe('Float')
    expect(fields.find((f) => f.name === 'isActive')!.type).toBe('Boolean')
    expect(fields.find((f) => f.name === 'createdAt')!.type).toBe('DateTime')
    expect(fields.find((f) => f.name === 'data')!.type).toBe('Json')
    expect(fields.find((f) => f.name === 'content')!.type).toBe('String')
    expect(fields.find((f) => f.name === 'avatar')!.type).toBe('Bytes')
  })

  it('requires schema for mysql', async () => {
    const exec = createMockExecutor([], [], [], [])

    await expect(
      introspectDatabase(exec, dialect, { scopeField: 'orgId' }),
    ).rejects.toThrow('MySQL requires a schema')
  })

  it('builds FK edges from referenced_table_name', async () => {
    const exec = createMockExecutor(
      [{ table_name: 'user' }, { table_name: 'organization' }],
      [
        { table_name: 'user', column_name: 'id', data_type: 'int', udt_name: 'int', is_nullable: 'NO', column_default: null },
        { table_name: 'user', column_name: 'org_id', data_type: 'int', udt_name: 'int', is_nullable: 'YES', column_default: null },
        { table_name: 'organization', column_name: 'id', data_type: 'int', udt_name: 'int', is_nullable: 'NO', column_default: null },
      ],
      [
        { table_name: 'user', column_name: 'id' },
        { table_name: 'organization', column_name: 'id' },
      ],
      [{ from_table: 'user', from_column: 'org_id', to_table: 'organization', to_column: 'id', is_nullable: 'YES' }],
    )

    const result = await introspectDatabase(exec, dialect, { scopeField: 'orgId', schema: 'mydb' })

    expect(result.schema.edges).toHaveLength(1)
    expect(result.schema.edges[0]).toEqual({
      from: 'User',
      to: 'Organization',
      localField: 'orgId',
      foreignField: 'id',
      nullable: true,
    })
  })
})
