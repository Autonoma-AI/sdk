/** Database dialect abstraction — generates dialect-specific SQL strings. */
export interface Dialect {
  readonly name: 'postgres' | 'mysql' | 'sqlite'
  /** Parameter placeholder for index (1-based). Postgres: $1, MySQL/SQLite: ? */
  param(index: number): string
  /** Quote an identifier. Postgres: "name", MySQL: `name` */
  quoteId(name: string): string
  /** Whether INSERT ... RETURNING is supported */
  readonly supportsReturning: boolean

  /** SQL to list all base tables in a schema/database */
  tablesSQL(schema: string): string
  /** SQL to list all columns for all tables in a schema/database */
  columnsSQL(schema: string): string
  /** SQL to list primary key columns */
  primaryKeysSQL(schema: string): string
  /** SQL to list foreign key relationships */
  foreignKeysSQL(schema: string): string
  /** SQL to list enum types and their values */
  enumsSQL(schema: string): string
}

export const postgres: Dialect = {
  name: 'postgres',
  param: (i) => `$${i}`,
  quoteId: (name) => `"${name}"`,
  supportsReturning: true,

  tablesSQL: (schema) => `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = '${schema}'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `,

  columnsSQL: (schema) => `
    SELECT
      table_name,
      column_name,
      data_type,
      udt_name,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = '${schema}'
    ORDER BY table_name, ordinal_position
  `,

  primaryKeysSQL: (schema) => `
    SELECT
      tc.table_name,
      kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = '${schema}'
    ORDER BY tc.table_name, kcu.ordinal_position
  `,

  foreignKeysSQL: (schema) => `
    SELECT
      kcu.table_name AS from_table,
      kcu.column_name AS from_column,
      ccu.table_name AS to_table,
      ccu.column_name AS to_column,
      c.is_nullable
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    LEFT JOIN information_schema.columns c
      ON c.table_schema = kcu.table_schema
      AND c.table_name = kcu.table_name
      AND c.column_name = kcu.column_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = '${schema}'
    ORDER BY kcu.table_name, kcu.ordinal_position
  `,

  enumsSQL: () => `
    SELECT t.typname AS enum_name, e.enumlabel AS enum_value
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    ORDER BY t.typname, e.enumsortorder
  `,
}

export const mysql: Dialect = {
  name: 'mysql',
  param: () => '?',
  quoteId: (name) => `\`${name}\``,
  supportsReturning: false,

  tablesSQL: (schema) => `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = '${schema}'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `,

  columnsSQL: (schema) => `
    SELECT
      table_name,
      column_name,
      data_type,
      column_type AS udt_name,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = '${schema}'
    ORDER BY table_name, ordinal_position
  `,

  primaryKeysSQL: (schema) => `
    SELECT
      tc.table_name,
      kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = '${schema}'
    ORDER BY tc.table_name, kcu.ordinal_position
  `,

  foreignKeysSQL: (schema) => `
    SELECT
      kcu.table_name AS from_table,
      kcu.column_name AS from_column,
      kcu.referenced_table_name AS to_table,
      kcu.referenced_column_name AS to_column,
      c.is_nullable
    FROM information_schema.key_column_usage kcu
    JOIN information_schema.columns c
      ON c.table_schema = kcu.table_schema
      AND c.table_name = kcu.table_name
      AND c.column_name = kcu.column_name
    WHERE kcu.referenced_table_name IS NOT NULL
      AND kcu.table_schema = '${schema}'
    ORDER BY kcu.table_name, kcu.ordinal_position
  `,

  // MySQL enums are embedded in column_type like "enum('a','b','c')"
  // We extract them during column introspection, so this returns empty.
  enumsSQL: () => `SELECT NULL AS enum_name, NULL AS enum_value FROM DUAL WHERE 1 = 0`,
}

export function getDialect(name: 'postgres' | 'mysql' | 'sqlite' = 'postgres'): Dialect {
  switch (name) {
    case 'postgres':
      return postgres
    case 'mysql':
      return mysql
    default:
      throw new Error(`Dialect "${name}" is not yet supported. Currently only "postgres" and "mysql" are available.`)
  }
}
