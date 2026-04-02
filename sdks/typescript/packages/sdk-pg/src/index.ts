import type { SQLExecutor } from '@autonoma-ai/sdk'

interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>
  connect(): Promise<PgPoolClient>
}

interface PgPoolClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>
  release(): void
}

/**
 * Create a SQLExecutor from a pg (node-postgres) Pool.
 *
 * @example
 * ```ts
 * import { pgExecutor } from '@autonoma-ai/sdk-pg'
 * import { Pool } from 'pg'
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL })
 *
 * const handler = createHandler({
 *   executor: pgExecutor(pool),
 *   scopeField: 'organizationId',
 *   sharedSecret: process.env.AUTONOMA_SECRET!,
 *   signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
 * })
 * ```
 */
export function pgExecutor(pool: PgPool): SQLExecutor {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const { rows } = await pool.query(sql, params)
      return rows as T[]
    },

    async transaction<T>(fn: (tx: SQLExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      await client.query('BEGIN')
      try {
        const txExecutor: SQLExecutor = {
          async query<U = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<U[]> {
            const { rows } = await client.query(sql, params)
            return rows as U[]
          },
          transaction: (innerFn) => innerFn(txExecutor),
        }
        const result = await fn(txExecutor)
        await client.query('COMMIT')
        return result
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    },
  }
}
