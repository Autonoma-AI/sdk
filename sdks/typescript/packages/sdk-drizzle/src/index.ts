import { sql as sqlTag, type SQL } from 'drizzle-orm'
import type { SQLExecutor } from '@autonoma-ai/sdk'

/**
 * Minimal surface we need from a Drizzle database instance. Real Drizzle DBs
 * (NodePgDatabase, MySql2Database, BetterSQLite3Database, …) satisfy this
 * structurally — `execute` takes a Drizzle `SQL`/`SQLWrapper`, not a POJO, and
 * `transaction` hands back a tx object that has the same shape.
 */
interface DrizzleDBLike {
  execute(query: SQL): Promise<unknown>
  transaction<T>(fn: (tx: DrizzleDBLike) => Promise<T>): Promise<T>
}

/**
 * Convert a raw parameterized SQL string (as emitted by the SDK — `$1`/`$2`
 * for Postgres, `?` for MySQL) into a Drizzle `SQL` object. Splitting with a
 * capturing group interleaves literal fragments and placeholders in order;
 * we map each piece to either `sql.raw(literal)` or `` sql`${value}` `` and
 * let Drizzle re-emit the params using the target driver's style.
 */
function buildSql(raw: string, params: readonly unknown[]): SQL {
  let positional = 0
  const chunks = raw.split(/(\$\d+|\?)/).map((part) => {
    if (part === '?') return sqlTag`${params[positional++]}`
    const m = /^\$(\d+)$/.exec(part)
    return m ? sqlTag`${params[Number(m[1]) - 1]}` : sqlTag.raw(part)
  })
  return sqlTag.join(chunks)
}

/**
 * Normalize a Drizzle `execute` result into a rows array.
 * - pg-family: `{ rows, rowCount, … }` → `rows`
 * - mysql2:    `[rows, fields]` tuple → first element if it's an array
 * - other:     empty array (INSERT/DELETE with no result set)
 */
function extractRows<T>(result: unknown): T[] {
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows
    if (Array.isArray(rows)) return rows as T[]
  }
  if (Array.isArray(result) && Array.isArray(result[0])) {
    return result[0] as T[]
  }
  return []
}

/**
 * Create a SQLExecutor from a Drizzle database instance.
 *
 * @example
 * ```ts
 * import { drizzleExecutor } from '@autonoma-ai/sdk-drizzle'
 * import { db } from '~/db'
 *
 * const handler = createHandler({
 *   executor: drizzleExecutor(db),
 *   scopeField: 'organizationId',
 *   sharedSecret: process.env.AUTONOMA_SECRET!,
 *   signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
 * })
 * ```
 */
export function drizzleExecutor(db: DrizzleDBLike): SQLExecutor {
  const adapt = (d: DrizzleDBLike): SQLExecutor => ({
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const result = await d.execute(buildSql(sql, params ?? []))
      return extractRows<T>(result)
    },
    transaction<T>(fn: (tx: SQLExecutor) => Promise<T>): Promise<T> {
      return d.transaction((txDb) => fn(adapt(txDb)))
    },
  })
  return adapt(db)
}
