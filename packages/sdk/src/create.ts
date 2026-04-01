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
): Promise<Record<string, Record<string, unknown>[]>> {
  const results: Record<string, Record<string, unknown>[]> = {}

  for (const [model, entitySpec] of Object.entries(spec)) {
    const dbTable = tableMap.get(model)
    if (!dbTable) throw new Error(`Unknown model "${model}". Not found in database tables.`)
    const colMap = columnMaps.get(model) ?? new Map<string, string>()

    if (entitySpec.batch && entitySpec.fields.length > 0) {
      results[model] = await insertBatch(executor, dialect, dbTable, colMap, entitySpec.fields)
    } else {
      const created: Record<string, unknown>[] = []
      for (const fields of entitySpec.fields) {
        const [record] = await insertOne(executor, dialect, dbTable, colMap, fields)
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
): Promise<void> {
  const dbTable = tableMap.get(model)
  if (!dbTable) throw new Error(`Unknown model "${model}" for update.`)
  const colMap = columnMaps.get(model) ?? new Map<string, string>()

  const setClauses: string[] = []
  const params: unknown[] = []
  let paramIdx = 1

  for (const [fieldName, value] of Object.entries(fields)) {
    const dbCol = colMap.get(fieldName) ?? fieldName
    setClauses.push(`${dialect.quoteId(dbCol)} = ${dialect.param(paramIdx)}`)
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
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  // Always generate a client-side ID when none is provided.
  // Many ORMs (e.g. Prisma's @default(cuid())) generate IDs in the application
  // layer, not as DB-level defaults. Without this, INSERT would send NULL for
  // the PK column and fail with a NOT NULL violation.
  const idFieldName = reverseGet(colMap, findIdCol(colMap)) ?? 'id'
  if (fields[idFieldName] === undefined) {
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
    placeholders.push(dialect.param(paramIdx))
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
  const id = fields[idFieldName]

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
  fieldsArr: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (fieldsArr.length === 0) return []

  const fieldNames = Object.keys(fieldsArr[0]!)
  const dbCols = fieldNames.map((f) => dialect.quoteId(colMap.get(f) ?? f))

  const params: unknown[] = []
  const valueTuples: string[] = []
  let paramIdx = 1

  for (const fields of fieldsArr) {
    const placeholders: string[] = []
    for (const fieldName of fieldNames) {
      placeholders.push(dialect.param(paramIdx))
      params.push(serializeValue(fields[fieldName], dialect))
      paramIdx++
    }
    valueTuples.push(`(${placeholders.join(', ')})`)
  }

  const colList = dbCols.join(', ')
  const valList = valueTuples.join(', ')

  if (dialect.supportsReturning) {
    const sql = `INSERT INTO ${dialect.quoteId(dbTable)} (${colList}) VALUES ${valList} RETURNING *`
    return mapRowsBack(await executor.query(sql, params), colMap)
  }

  // MySQL: batch insert, no rows returned (same as old Prisma createMany behavior)
  await executor.query(
    `INSERT INTO ${dialect.quoteId(dbTable)} (${colList}) VALUES ${valList}`,
    params,
  )
  return []
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
 * Serialize a JS value for SQL insertion.
 * Handles MySQL-specific quirks:
 *  - Objects/arrays → JSON.stringify (MySQL requires JSON strings, not objects)
 *  - ISO 8601 datetime strings → MySQL DATETIME format
 */
function serializeValue(value: unknown, dialect: Dialect): unknown {
  if (value === null || value === undefined) return value

  // JSON: MySQL needs a string, Postgres accepts objects via jsonb
  if (typeof value === 'object' && !(value instanceof Date)) {
    if (dialect.name === 'mysql') return JSON.stringify(value)
    return value
  }

  // DateTime: MySQL doesn't accept ISO 8601 with 'T' and 'Z'
  if (typeof value === 'string' && dialect.name === 'mysql') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
      return value.replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '')
    }
  }

  return value
}
