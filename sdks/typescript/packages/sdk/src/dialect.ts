/** Database dialect abstraction — generates dialect-specific SQL strings. */

import {
  POSTGRES_TABLES,
  POSTGRES_COLUMNS,
  POSTGRES_PRIMARY_KEYS,
  POSTGRES_FOREIGN_KEYS,
  POSTGRES_ENUMS,
  MYSQL_TABLES,
  MYSQL_COLUMNS,
  MYSQL_PRIMARY_KEYS,
  MYSQL_FOREIGN_KEYS,
  MYSQL_ENUMS,
} from './generated/sql-queries'

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

const replaceSchema = (template: string, schema: string) =>
  template.replace('{{schema}}', schema)

export const postgres: Dialect = {
  name: 'postgres',
  param: (i) => `$${i}`,
  quoteId: (name) => `"${name}"`,
  supportsReturning: true,

  tablesSQL: (schema) => replaceSchema(POSTGRES_TABLES, schema),
  columnsSQL: (schema) => replaceSchema(POSTGRES_COLUMNS, schema),
  primaryKeysSQL: (schema) => replaceSchema(POSTGRES_PRIMARY_KEYS, schema),
  foreignKeysSQL: (schema) => replaceSchema(POSTGRES_FOREIGN_KEYS, schema),
  enumsSQL: () => POSTGRES_ENUMS,
}

export const mysql: Dialect = {
  name: 'mysql',
  param: () => '?',
  quoteId: (name) => `\`${name}\``,
  supportsReturning: false,

  tablesSQL: (schema) => replaceSchema(MYSQL_TABLES, schema),
  columnsSQL: (schema) => replaceSchema(MYSQL_COLUMNS, schema),
  primaryKeysSQL: (schema) => replaceSchema(MYSQL_PRIMARY_KEYS, schema),
  foreignKeysSQL: (schema) => replaceSchema(MYSQL_FOREIGN_KEYS, schema),
  enumsSQL: () => MYSQL_ENUMS,
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
