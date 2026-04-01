import type { SQLExecutor } from '@autonoma-ai/sdk'

interface PrismaClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
  $transaction<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T>
}

/**
 * Create a SQLExecutor from a Prisma client.
 *
 * @example
 * ```ts
 * import { prismaExecutor } from '@autonoma-ai/sdk-prisma'
 * import { prisma } from './db'
 *
 * const handler = createHandler({
 *   executor: prismaExecutor(prisma),
 *   scopeField: 'organizationId',
 *   sharedSecret: process.env.AUTONOMA_SECRET!,
 *   signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
 * })
 * ```
 */
export function prismaExecutor(prisma: PrismaClient): SQLExecutor {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const result = await prisma.$queryRawUnsafe<T[]>(sql, ...(params ?? []))
      return result
    },

    async transaction<T>(fn: (tx: SQLExecutor) => Promise<T>): Promise<T> {
      return prisma.$transaction(async (txClient) => {
        const txExecutor: SQLExecutor = {
          async query<U = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<U[]> {
            return txClient.$queryRawUnsafe<U[]>(sql, ...(params ?? []))
          },
          transaction: (innerFn) => innerFn(txExecutor),
        }
        return fn(txExecutor)
      })
    },
  }
}
