import { randomUUID } from 'node:crypto'
import type { SQLExecutor, ResolvedEntitySpec, CreateContext } from './types'
import type { Dialect } from './dialect'

/**
 * Create entities via raw SQL INSERT.
 *
 * Entities arrive pre-sorted by FK order (handler does topo-sort via tree.ts).
 * Each model in `spec` is inserted sequentially; within a model, batch mode
 * uses a single multi-row INSERT while normal mode inserts one row at a time.
 *
 * For dialects with RETURNING (Postgres): INSERT ... RETURNING *
 * For dialects without (MySQL): INSERT then SELECT via LAST_INSERT_ID()
 */
export async function createEntities(
  executor: SQLExecutor,
  dialect: Dialect,
  tableMap: Map<string, string>,
  columnMaps: Map<string, Map<string, string>>,
  spec: Record<string, ResolvedEntitySpec>,
  _context: CreateContext,
  enumTypeMaps: Map<string, Map<string, string>> = new Map(),
): Promise<Record<string, Record<string, unknown>[]>> {
  const results: Record<string, Record<string, unknown>[]> = {}

  for (const [model, entitySpec] of Object.entries(spec)) {
    const dbTable = tableMap.get(model)
    if (!dbTable) throw new Error(`Unknown model "${model}". Not found in database tables.`)
    const colMap = columnMaps.get(model) ?? new Map<string, string>()
    const enumTypeMap = enumTypeMaps.get(model) ?? new Map<string, string>()

    if (entitySpec.batch && entitySpec.fields.length > 0) {
      results[model] = await insertBatch(executor, dialect, dbTable, colMap, enumTypeMap, entitySpec.fields)
    } else {
      const created: Record<string, unknown>[] = []
      for (const fields of entitySpec.fields) {
        const [record] = await insertOne(executor, dialect, dbTable, colMap, enumTypeMap, fields)
        if (record) created.push(record)
      }
      results[model] = created
    }
  }

  return results
}

/**
 * Update a single record by primary key. Used for circular FK backfill.
 */
export async function updateEntity(
  executor: SQLExecutor,
  dialect: Dialect,
  tableMap: Map<string, string>,
  columnMaps: Map<string, Map<string, string>>,
  model: string,
  id: string,
  fields: Record<string, unknown>,
  enumTypeMaps: Map<string, Map<string, string>> = new Map(),
): Promise<void> {
  const dbTable = tableMap.get(model)
  if (!dbTable) throw new Error(`Unknown model "${model}" for update.`)
  const colMap = columnMaps.get(model) ?? new Map<string, string>()
  const enumTypeMap = enumTypeMaps.get(model) ?? new Map<string, string>()

  const setClauses: string[] = []
  const params: unknown[] = []
  let paramIdx = 1

  for (const [fieldName, value] of Object.entries(fields)) {
    const dbCol = colMap.get(fieldName) ?? fieldName
    setClauses.push(`${dialect.quoteId(dbCol)} = ${castParam(dialect, paramIdx, enumTypeMap, fieldName)}`)
    params.push(serializeValue(value, dialect))
    paramIdx++
  }

  const idCol = colMap.get('id') ?? 'id'
  params.push(id)

  const sql = `UPDATE ${dialect.quoteId(dbTable)} SET ${setClauses.join(', ')} WHERE ${dialect.quoteId(idCol)} = ${dialect.param(paramIdx)}`
  await executor.query(sql, params)
}

// --- Internal helpers ---

async function insertOne(
  executor: SQLExecutor,
  dialect: Dialect,
  dbTable: string,
  colMap: Map<string, string>,
  enumTypeMap: Map<string, string>,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  // Generate a client-side ID when none is provided and the table has an 'id' column.
  // Many ORMs (e.g. Prisma's @default(cuid())) generate IDs in the application
  // layer, not as DB-level defaults. Without this, INSERT would send NULL for
  // the PK column and fail with a NOT NULL violation.
  // Tables whose PK is not named 'id' (e.g. WebApplicationData uses applicationId
  // as its PK) already have their PK set via FK wiring, so we skip injection.
  const idFieldName = reverseGet(colMap, findIdCol(colMap))
  if (idFieldName && fields[idFieldName] === undefined) {
    fields = { ...fields, [idFieldName]: randomUUID() }
  }

  const entries = Object.entries(fields)

  if (entries.length === 0) {
    const sql = `INSERT INTO ${dialect.quoteId(dbTable)} DEFAULT VALUES RETURNING *`
    return mapRowsBack(await executor.query(sql), colMap)
  }

  const dbCols: string[] = []
  const params: unknown[] = []
  const placeholders: string[] = []
  let paramIdx = 1

  for (const [fieldName, value] of entries) {
    const dbCol = colMap.get(fieldName) ?? fieldName
    dbCols.push(dialect.quoteId(dbCol))
    placeholders.push(castParam(dialect, paramIdx, enumTypeMap, fieldName))
    params.push(serializeValue(value, dialect))
    paramIdx++
  }

  const colList = dbCols.join(', ')
  const valList = placeholders.join(', ')

  if (dialect.supportsReturning) {
    const sql = `INSERT INTO ${dialect.quoteId(dbTable)} (${colList}) VALUES (${valList}) RETURNING *`
    return mapRowsBack(await executor.query(sql, params), colMap)
  }

  // MySQL: INSERT then SELECT back by the ID we set
  await executor.query(
    `INSERT INTO ${dialect.quoteId(dbTable)} (${colList}) VALUES (${valList})`,
    params,
  )

  const idCol = findIdCol(colMap)
  const id = fields[idFieldName ?? 'id']

  return mapRowsBack(
    await executor.query(
      `SELECT * FROM ${dialect.quoteId(dbTable)} WHERE ${dialect.quoteId(idCol)} = ${dialect.param(1)}`,
      [id],
    ),
    colMap,
  )
}

async function insertBatch(
  executor: SQLExecutor,
  dialect: Dialect,
  dbTable: string,
  colMap: Map<string, string>,
  enumTypeMap: Map<string, string>,
  fieldsArr: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (fieldsArr.length === 0) return []

  // Generate client-side IDs for batch records, same as insertOne.
  // Only inject if the table actually has an 'id' column.
  const idFieldName = reverseGet(colMap, findIdCol(colMap))
  if (idFieldName) {
    fieldsArr = fieldsArr.map((fields) => {
      if (fields[idFieldName] === undefined) {
        return { ...fields, [idFieldName]: randomUUID() }
      }
      return fields
    })
  }

  // Compute the union of keys across all rows in deterministic (sorted) order.
  const fieldNameSet = new Set<string>()
  for (const fields of fieldsArr) {
    for (const key of Object.keys(fields)) {
      fieldNameSet.add(key)
    }
  }
  const fieldNames = [...fieldNameSet].sort()

  // If no fields at all, fall back to individual DEFAULT VALUES inserts.
  if (fieldNames.length === 0) {
    const allResults: Record<string, unknown>[] = []
    for (const fields of fieldsArr) {
      const [record] = await insertOne(executor, dialect, dbTable, colMap, enumTypeMap, fields)
      if (record) allResults.push(record)
    }
    return allResults
  }

  const dbCols = fieldNames.map((f) => dialect.quoteId(colMap.get(f) ?? f))
  const colList = dbCols.join(', ')

  // Postgres has a max of 32,767 bind variables per statement.
  // Chunk large batches to stay within this limit.
  const MAX_PARAMS = 32_000
  const chunkSize = Math.max(1, Math.floor(MAX_PARAMS / fieldNames.length))
  const allResults: Record<string, unknown>[] = []

  for (let offset = 0; offset < fieldsArr.length; offset += chunkSize) {
    const chunk = fieldsArr.slice(offset, offset + chunkSize)
    const params: unknown[] = []
    const valueTuples: string[] = []
    let paramIdx = 1

    for (const fields of chunk) {
      const placeholders: string[] = []
      for (const fieldName of fieldNames) {
        placeholders.push(castParam(dialect, paramIdx, enumTypeMap, fieldName))
        params.push(serializeValue(fields[fieldName], dialect))
        paramIdx++
      }
      valueTuples.push(`(${placeholders.join(', ')})`)
    }

    const valList = valueTuples.join(', ')

    if (dialect.supportsReturning) {
      const sql = `INSERT INTO ${dialect.quoteId(dbTable)} (${colList}) VALUES ${valList} RETURNING *`
      allResults.push(...mapRowsBack(await executor.query(sql, params), colMap))
    } else {
      await executor.query(
        `INSERT INTO ${dialect.quoteId(dbTable)} (${colList}) VALUES ${valList}`,
        params,
      )
    }
  }

  return allResults
}

/**
 * Map DB column names back to camelCase field names in returned rows.
 */
function mapRowsBack(
  rows: Record<string, unknown>[],
  colMap: Map<string, string>,
): Record<string, unknown>[] {
  if (colMap.size === 0) return rows

  const reverse = new Map<string, string>()
  for (const [fieldName, dbCol] of colMap) {
    reverse.set(dbCol, fieldName)
  }

  return rows.map((row) => {
    const mapped: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      const fieldName = reverse.get(key) ?? key
      mapped[fieldName] = value
    }
    return mapped
  })
}

function findIdCol(colMap: Map<string, string>): string {
  return colMap.get('id') ?? 'id'
}

function reverseGet(map: Map<string, string>, dbName: string): string | null {
  for (const [key, val] of map) {
    if (val === dbName) return key
  }
  return null
}

/**
 * Build a parameter placeholder with an optional Postgres enum cast.
 * e.g. `$1::"ApplicationArchitecture"` for enum fields, or just `$1` otherwise.
 */
function castParam(
  dialect: Dialect,
  paramIdx: number,
  enumTypeMap: Map<string, string>,
  fieldName: string,
): string {
  const placeholder = dialect.param(paramIdx)
  if (dialect.name === 'postgres') {
    const enumType = enumTypeMap.get(fieldName)
    if (enumType) return `${placeholder}::${dialect.quoteId(enumType)}`
  }
  return placeholder
}

/** Pre-compiled regex for MySQL datetime detection (avoids re-compilation per call). */
const MYSQL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

/**
 * Serialize a JS value for SQL insertion.
 * Handles MySQL-specific quirks:
 *  - Objects/arrays → JSON.stringify (MySQL requires JSON strings, not objects)
 *  - ISO 8601 datetime strings → MySQL DATETIME format
 */
function serializeValue(value: unknown, dialect: Dialect): unknown {
  if (value === null || value === undefined) return null

  // JSON: Both MySQL and Postgres need stringified JSON when using parameterized
  // queries with explicit casts (e.g. $1::jsonb). Postgres $queryRawUnsafe cannot
  // pass JS objects directly as parameters.
  if (typeof value === 'object' && !(value instanceof Date)) {
    return JSON.stringify(value)
  }

  // DateTime: MySQL doesn't accept ISO 8601 with 'T' and 'Z'
  if (typeof value === 'string' && dialect.name === 'mysql') {
    if (MYSQL_DATETIME_RE.test(value)) {
      return value.replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '')
    }
  }

  return value
}
