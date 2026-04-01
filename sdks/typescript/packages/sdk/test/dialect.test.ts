import { describe, it, expect } from 'vitest'
import { getDialect, postgres, mysql } from '../src/dialect'

describe('getDialect', () => {
  it('returns postgres by default', () => {
    expect(getDialect().name).toBe('postgres')
  })

  it('returns postgres explicitly', () => {
    expect(getDialect('postgres')).toBe(postgres)
  })

  it('returns mysql', () => {
    expect(getDialect('mysql')).toBe(mysql)
  })

  it('throws for unsupported dialect', () => {
    expect(() => getDialect('sqlite' as any)).toThrow('not yet supported')
  })
})

describe('postgres dialect', () => {
  it('uses $N placeholders', () => {
    expect(postgres.param(1)).toBe('$1')
    expect(postgres.param(5)).toBe('$5')
  })

  it('quotes with double quotes', () => {
    expect(postgres.quoteId('user')).toBe('"user"')
    expect(postgres.quoteId('run_step')).toBe('"run_step"')
  })

  it('supports RETURNING', () => {
    expect(postgres.supportsReturning).toBe(true)
  })

  it('generates tables SQL', () => {
    const sql = postgres.tablesSQL('public')
    expect(sql).toContain('information_schema.tables')
    expect(sql).toContain("'public'")
  })

  it('generates FK SQL with constraint_column_usage', () => {
    const sql = postgres.foreignKeysSQL('public')
    expect(sql).toContain('constraint_column_usage')
    expect(sql).toContain('FOREIGN KEY')
  })

  it('generates enum SQL using pg_type', () => {
    const sql = postgres.enumsSQL('public')
    expect(sql).toContain('pg_type')
    expect(sql).toContain('pg_enum')
  })
})

describe('mysql dialect', () => {
  it('uses ? placeholders', () => {
    expect(mysql.param(1)).toBe('?')
    expect(mysql.param(99)).toBe('?')
  })

  it('quotes with backticks', () => {
    expect(mysql.quoteId('user')).toBe('`user`')
    expect(mysql.quoteId('run_step')).toBe('`run_step`')
  })

  it('does not support RETURNING', () => {
    expect(mysql.supportsReturning).toBe(false)
  })

  it('generates tables SQL', () => {
    const sql = mysql.tablesSQL('mydb')
    expect(sql).toContain('information_schema.tables')
    expect(sql).toContain("'mydb'")
  })

  it('generates FK SQL using key_column_usage with referenced_table_name', () => {
    const sql = mysql.foreignKeysSQL('mydb')
    expect(sql).toContain('referenced_table_name')
    expect(sql).toContain('referenced_column_name')
    expect(sql).not.toContain('constraint_column_usage')
  })

  it('generates empty enum SQL (enums parsed from column_type)', () => {
    const sql = mysql.enumsSQL('mydb')
    expect(sql).toContain('1 = 0')
  })
})
