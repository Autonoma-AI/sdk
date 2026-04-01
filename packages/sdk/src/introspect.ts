import type { SQLExecutor, SchemaInfo, ModelInfo, FieldInfo, FKEdge } from './types'
import type { Dialect } from './dialect'

/** Internal result including name mapping tables */
export interface IntrospectionResult {
  schema: SchemaInfo
  /** model name → DB table name */
  tableMap: Map<string, string>
  /** model name → (field name → DB column name) */
  columnMaps: Map<string, Map<string, string>>
}

interface TableRow { table_name: string }
interface ColumnRow {
  table_name: string
  column_name: string
  data_type: string
  udt_name: string
  is_nullable: string
  column_default: string | null
}
interface PKRow { table_name: string; column_name: string }
interface FKRow {
  from_table: string
  from_column: string
  to_table: string
  to_column: string
  is_nullable: string
}
interface EnumRow { enum_name: string; enum_value: string }

/**
 * Introspect a database via information_schema to build SchemaInfo.
 *
 * Auto-maps DB names (snake_case) to model names (PascalCase) and
 * field names (camelCase). Override with `tableNameMap`.
 */
export async function introspectDatabase(
  executor: SQLExecutor,
  dialect: Dialect,
  config: {
    scopeField: string
    schema?: string
    tableNameMap?: Record<string, string>
    excludeTables?: string[]
  },
): Promise<IntrospectionResult> {
  const dbSchema = config.schema ?? (dialect.name === 'mysql' ? undefined : 'public')
  if (!dbSchema) {
    throw new Error('MySQL requires a schema (database name). Pass it via config.schema or HandlerConfig.dbSchema.')
  }
  const excludeSet = new Set(config.excludeTables ?? ['_prisma_migrations'])

  // Run all introspection queries in parallel.
  // Normalize row keys to lowercase — MySQL's information_schema can return
  // column names in uppercase (TABLE_NAME vs table_name).
  const [tableRows, columnRows, pkRows, fkRows, enumRows] = await Promise.all([
    executor.query<TableRow>(dialect.tablesSQL(dbSchema)).then(normalizeKeys),
    executor.query<ColumnRow>(dialect.columnsSQL(dbSchema)).then(normalizeKeys),
    executor.query<PKRow>(dialect.primaryKeysSQL(dbSchema)).then(normalizeKeys),
    executor.query<FKRow>(dialect.foreignKeysSQL(dbSchema)).then(normalizeKeys),
    executor.query<EnumRow>(dialect.enumsSQL(dbSchema)).then(normalizeKeys),
  ])

  // Build enum lookup: name → values[]
  // For Postgres: from pg_type/pg_enum rows
  // For MySQL: extracted from column_type in the column rows below
  const enumValues = new Map<string, string[]>()
  for (const row of enumRows) {
    if (!row.enum_name) continue
    if (!enumValues.has(row.enum_name)) enumValues.set(row.enum_name, [])
    enumValues.get(row.enum_name)!.push(row.enum_value)
  }

  // For MySQL, parse inline enums from column_type (udt_name alias)
  // e.g. "enum('WEB','ANDROID','IOS')" → ['WEB','ANDROID','IOS']
  if (dialect.name === 'mysql') {
    for (const col of columnRows) {
      const parsed = parseMySQLEnum(col.udt_name)
      if (parsed) {
        const enumKey = `${col.table_name}.${col.column_name}`
        enumValues.set(enumKey, parsed)
      }
    }
  }

  // Build PK lookup: table_name → Set<column_name>
  const pksByTable = new Map<string, Set<string>>()
  for (const row of pkRows) {
    if (!pksByTable.has(row.table_name)) pksByTable.set(row.table_name, new Set())
    pksByTable.get(row.table_name)!.add(row.column_name)
  }

  // Build table name mapping
  const userMap = config.tableNameMap ?? {}
  const tableMap = new Map<string, string>()
  const reverseTableMap = new Map<string, string>()

  // First, register user-provided mappings
  for (const [model, dbTable] of Object.entries(userMap)) {
    tableMap.set(model, dbTable)
    reverseTableMap.set(dbTable, model)
  }

  // Then auto-map remaining tables
  const dbTables = tableRows
    .map((r) => r.table_name)
    .filter((t) => !excludeSet.has(t))

  for (const dbTable of dbTables) {
    if (reverseTableMap.has(dbTable)) continue
    const modelName = snakeToPascal(dbTable)
    tableMap.set(modelName, dbTable)
    reverseTableMap.set(dbTable, modelName)
  }

  // Build column maps and model info
  const models: ModelInfo[] = []
  const columnMaps = new Map<string, Map<string, string>>()

  // Group columns by table
  const columnsByTable = new Map<string, ColumnRow[]>()
  for (const row of columnRows) {
    if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, [])
    columnsByTable.get(row.table_name)!.push(row)
  }

  for (const [modelName, dbTable] of tableMap) {
    const cols = columnsByTable.get(dbTable) ?? []
    const pks = pksByTable.get(dbTable) ?? new Set<string>()
    const colMap = new Map<string, string>()
    const fields: FieldInfo[] = []

    for (const col of cols) {
      const fieldName = snakeToCamel(col.column_name)
      colMap.set(fieldName, col.column_name)

      // Check for enum values
      let enumVals: string[] | undefined
      if (dialect.name === 'mysql') {
        enumVals = enumValues.get(`${col.table_name}.${col.column_name}`)
      } else {
        enumVals = enumValues.get(col.udt_name)
      }

      const type = enumVals
        ? `enum(${enumVals.join(',')})`
        : mapDataType(col.data_type, col.udt_name, dialect.name)

      fields.push({
        name: fieldName,
        type,
        isRequired: col.is_nullable === 'NO',
        isId: pks.has(col.column_name),
        hasDefault: col.column_default !== null,
      })
    }

    columnMaps.set(modelName, colMap)
    models.push({ name: modelName, fields })
  }

  // Build FK edges
  const edges: FKEdge[] = []
  for (const fk of fkRows) {
    const fromModel = reverseTableMap.get(fk.from_table)
    const toModel = reverseTableMap.get(fk.to_table)
    if (!fromModel || !toModel) continue

    const fromColMap = columnMaps.get(fromModel)
    const toColMap = columnMaps.get(toModel)
    const localField = fromColMap ? reverseGet(fromColMap, fk.from_column) ?? fk.from_column : fk.from_column
    const foreignField = toColMap ? reverseGet(toColMap, fk.to_column) ?? fk.to_column : fk.to_column

    edges.push({
      from: fromModel,
      to: toModel,
      localField,
      foreignField,
      nullable: fk.is_nullable === 'YES',
    })
  }

  // Build relations from FK edges.
  // For each edge (from→to), generate two relations:
  //   1. Parent-side: on the "to" model, a field pointing to "from" model (e.g., Organization.members)
  //   2. Child-side:  on the "from" model, a field pointing to "to" model (e.g., Member.organization)
  const relations: SchemaRelation[] = []
  for (const edge of edges) {
    // Parent-side: "to" model has a collection/reference to "from" model
    relations.push({
      parentModel: edge.to,
      childModel: edge.from,
      parentField: pluralCamelCase(edge.from),
      childField: edge.localField,
    })

    // Child-side: "from" model has a singular reference to "to" model (FK is on this side)
    relations.push({
      parentModel: edge.from,
      childModel: edge.to,
      parentField: lowerFirst(edge.to),
      childField: edge.localField,
    })
  }

  return {
    schema: { models, edges, relations, scopeField: config.scopeField },
    tableMap,
    columnMaps,
  }
}

// --- Name mapping utilities ---

function snakeToPascal(str: string): string {
  return str
    .split('_')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('')
}

function snakeToCamel(str: string): string {
  const pascal = snakeToPascal(str)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

/**
 * Parse MySQL inline enum definition: "enum('a','b','c')" → ['a','b','c']
 */
function parseMySQLEnum(columnType: string): string[] | null {
  if (!columnType) return null
  const match = columnType.match(/^enum\((.+)\)$/i)
  if (!match) return null
  return match[1]!
    .split(',')
    .map((v) => v.trim().replace(/^'|'$/g, ''))
}

function mapDataType(dataType: string, udtName: string, dialectName: string): string {
  const dt = dataType.toLowerCase()

  // Integer types
  if (dt === 'integer' || dt === 'smallint' || dt === 'bigint' || dt === 'int' || dt === 'mediumint' || dt === 'tinyint') return 'Int'

  // Float types
  if (dt === 'numeric' || dt === 'real' || dt === 'double precision' || dt === 'float' || dt === 'double' || dt === 'decimal') return 'Float'

  // Boolean
  if (dt === 'boolean' || dt === 'tinyint(1)') return 'Boolean'

  // String types
  if (dt === 'text' || dt === 'character varying' || dt === 'character' || dt === 'varchar' || dt === 'char'
    || dt === 'mediumtext' || dt === 'longtext' || dt === 'tinytext') return 'String'

  // DateTime types
  if (dt === 'timestamp with time zone' || dt === 'timestamp without time zone'
    || dt === 'date' || dt === 'time' || dt === 'datetime' || dt === 'timestamp') return 'DateTime'

  // JSON types
  if (dt === 'json' || dt === 'jsonb') return 'Json'

  // UUID / binary
  if (dt === 'uuid') return 'String'
  if (dt === 'bytea' || dt === 'blob' || dt === 'mediumblob' || dt === 'longblob' || dt === 'tinyblob' || dt === 'binary' || dt === 'varbinary') return 'Bytes'

  // Postgres user-defined (enums handled by caller)
  if (dt === 'user-defined' && dialectName === 'postgres') return udtName

  // MySQL enum is handled before this function is called
  if (dt === 'enum' || dt === 'set') return udtName

  return dataType
}

function lowerFirst(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1)
}

/**
 * Convert a PascalCase model name to a camelCase plural field name.
 * e.g., "Member" → "members", "Application" → "applications", "ApiKey" → "apiKeys"
 */
function pluralCamelCase(modelName: string): string {
  const camel = lowerFirst(modelName)
  return pluralize(camel)
}

function pluralize(str: string): string {
  if (str.endsWith('s') || str.endsWith('x') || str.endsWith('z') || str.endsWith('ch') || str.endsWith('sh')) {
    return str + 'es'
  }
  if (str.endsWith('y') && str.length > 1 && !isVowel(str.charAt(str.length - 2))) {
    return str.slice(0, -1) + 'ies'
  }
  return str + 's'
}

function isVowel(ch: string): boolean {
  return 'aeiou'.includes(ch.toLowerCase())
}

/**
 * Lowercase all keys in each row — handles MySQL information_schema returning
 * uppercase column names (TABLE_NAME, COLUMN_NAME, etc.)
 */
function normalizeKeys<T>(rows: T[]): T[] {
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row
    const normalized: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(row as Record<string, unknown>)) {
      normalized[key.toLowerCase()] = val
    }
    return normalized as T
  })
}

/** Reverse lookup: find the key whose value matches `dbName` */
function reverseGet(map: Map<string, string>, dbName: string): string | null {
  for (const [key, val] of map) {
    if (val === dbName) return key
  }
  return null
}
