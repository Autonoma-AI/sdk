import type { SQLExecutor } from '@autonoma-ai/sdk'

interface MySQL2Pool {
  query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]>
  getConnection(): Promise<MySQL2Connection>
}

interface MySQL2Connection {
  query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  release(): void
}

/**
 * Safely extract rows from a mysql2 query result.
 * SELECT returns RowDataPacket[], but INSERT/UPDATE/DELETE returns ResultSetHeader.
 */
function toRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  return []
}

/**
 * Create a SQLExecutor from a mysql2 pool (promise-based).
 *
 * @example
 * ```ts
 * import { mysqlExecutor } from '@autonoma-ai/sdk-mysql'
 * import mysql from 'mysql2/promise'
 *
 * const pool = mysql.createPool({ host: 'localhost', database: 'mydb', user: 'root' })
 *
 * const handler = createHandler({
 *   executor: mysqlExecutor(pool),
 *   dialect: 'mysql',
 *   dbSchema: 'mydb',
 *   scopeField: 'organizationId',
 *   sharedSecret: process.env.AUTONOMA_SECRET!,
 *   signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
 * })
 * ```
 */
export function mysqlExecutor(pool: MySQL2Pool): SQLExecutor {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const [result] = await pool.query(sql, params)
      return toRows<T>(result)
    },

    async transaction<T>(fn: (tx: SQLExecutor) => Promise<T>): Promise<T> {
      const conn = await pool.getConnection()
      await conn.beginTransaction()
      try {
        const txExecutor: SQLExecutor = {
          async query<U = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<U[]> {
            const [result] = await conn.query(sql, params)
            return toRows<U>(result)
          },
          transaction: (innerFn) => innerFn(txExecutor),
        }
        const result = await fn(txExecutor)
        await conn.commit()
        return result
      } catch (err) {
        await conn.rollback()
        throw err
      } finally {
        conn.release()
      }
    },
  }
}
