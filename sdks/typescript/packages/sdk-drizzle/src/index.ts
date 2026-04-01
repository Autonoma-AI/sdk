import type { SQLExecutor } from '@autonoma-ai/sdk'

interface DrizzleDB {
  execute(query: { sql: string; params: unknown[] }): Promise<{ rows: Record<string, unknown>[] }>
  transaction<T>(fn: (tx: DrizzleDB) => Promise<T>): Promise<T>
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
export function drizzleExecutor(db: DrizzleDB): SQLExecutor {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const result = await db.execute({ sql, params: params ?? [] })
      return result.rows as T[]
    },

    async transaction<T>(fn: (tx: SQLExecutor) => Promise<T>): Promise<T> {
      return db.transaction(async (txDb) => {
        const txExecutor: SQLExecutor = {
          async query<U = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<U[]> {
            const result = await txDb.execute({ sql, params: params ?? [] })
            return result.rows as U[]
          },
          transaction: (innerFn) => innerFn(txExecutor),
        }
        return fn(txExecutor)
      })
    },
  }
}
