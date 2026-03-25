import type { SchemaInfo, SchemaRelation, ModelInfo, FieldInfo, FKEdge } from '@autonoma/sdk'

export interface DrizzleAdapterConfig {
  scopeField: string
}

// DrizzleTable is accessed dynamically — Symbol.for('drizzle:Name') can't be in an interface
type DrizzleTable = Record<string | symbol, unknown> & {
  _?: { name: string; columns: Record<string, DrizzleColumn> }
}

interface DrizzleColumn {
  name: string
  dataType: string
  notNull: boolean
  primary: boolean
  hasDefault: boolean
}

interface DrizzleRelation {
  fieldName: string
  referencedTableName: string
  columns?: Array<{ name: string }>
  foreignColumns?: Array<{ name: string }>
  isNullable?: boolean
}

/**
 * Introspect a Drizzle schema to extract schema metadata.
 */
export function introspectDrizzle(
  schema: Record<string, unknown>,
  config: DrizzleAdapterConfig,
): SchemaInfo {
  const models: ModelInfo[] = []
  const edges: FKEdge[] = []
  const tables = new Map<string, DrizzleTable>()

  // Find all table objects in the schema export
  for (const [key, value] of Object.entries(schema)) {
    if (isTable(value)) {
      tables.set(key, value as DrizzleTable)
    }
  }

  for (const [key, table] of tables) {
    const tableName = getTableName(table, key)
    const columns = getTableColumns(table)
    const fields: FieldInfo[] = []

    for (const [colName, col] of Object.entries(columns)) {
      fields.push({
        name: colName,
        type: col.dataType,
        isRequired: col.notNull,
        isId: col.primary,
        hasDefault: col.hasDefault,
      })
    }

    models.push({ name: tableName, fields })
  }

  // Extract relations from the schema
  for (const [key, value] of Object.entries(schema)) {
    if (isRelations(value)) {
      const rels = extractRelations(value)
      for (const rel of rels) {
        if (rel.columns?.length && rel.foreignColumns?.length) {
          edges.push({
            from: getRelationSourceTable(key, tables),
            to: rel.referencedTableName,
            localField: rel.columns[0]!.name,
            foreignField: rel.foreignColumns[0]!.name,
            nullable: !rel.isNullable,
          })
        }
      }
    }
  }

  return { models, edges, relations: [], scopeField: config.scopeField }
}

function isTable(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string | symbol, unknown>
  // Drizzle tables have a Symbol.for('drizzle:Name') or a _ property with columns
  return (
    Symbol.for('drizzle:Name') in v ||
    (v._ != null && typeof v._ === 'object' && 'columns' in (v._ as object))
  )
}

function isRelations(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  // Relations objects have a specific structure
  const v = value as Record<string, unknown>
  return v.dbName != null || v.table != null
}

function getTableName(table: DrizzleTable, fallback: string): string {
  const sym = Symbol.for('drizzle:Name')
  if (sym in table) return (table as any)[sym] as string
  if (table._?.name) return table._.name
  return fallback
}

function getTableColumns(table: DrizzleTable): Record<string, DrizzleColumn> {
  if (table._?.columns) return table._.columns
  // Fallback: inspect own properties that look like columns
  const cols: Record<string, DrizzleColumn> = {}
  for (const [key, val] of Object.entries(table)) {
    if (val && typeof val === 'object' && 'dataType' in val) {
      cols[key] = val as DrizzleColumn
    }
  }
  return cols
}

function extractRelations(_value: unknown): DrizzleRelation[] {
  // Drizzle relations are complex — for the prototype, return empty
  // Real implementation would traverse the relations() call tree
  return []
}

function getRelationSourceTable(
  key: string,
  tables: Map<string, DrizzleTable>,
): string {
  // Convention: relations are named like `usersRelations` → `users`
  const match = key.match(/^(.+?)Relations$/)
  if (match) {
    const tableName = match[1]!
    if (tables.has(tableName)) return getTableName(tables.get(tableName)!, tableName)
  }
  return key
}
