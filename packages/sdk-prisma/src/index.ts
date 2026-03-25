import type { OrmAdapter, SchemaInfo, ResolvedEntitySpec, CreateContext } from '@autonoma-ai/sdk'
import { introspectPrisma, type PrismaAdapterConfig } from './introspect'
import { createEntities } from './create'
import { teardown } from './teardown'

export type { PrismaAdapterConfig }

/**
 * Create a Prisma ORM adapter for the Autonoma SDK.
 *
 * @example
 * ```ts
 * import { prismaAdapter } from '@autonoma-ai/sdk-prisma'
 * import { prisma } from './db'
 *
 * const adapter = prismaAdapter(prisma, { scopeField: 'organizationId' })
 * ```
 */
export function prismaAdapter(
  prisma: any,
  config: PrismaAdapterConfig,
): OrmAdapter {
  let cachedSchema: SchemaInfo | null = null

  return {
    getSchema() {
      if (!cachedSchema) {
        cachedSchema = introspectPrisma(prisma, config)
      }
      return cachedSchema
    },

    async createEntities(
      spec: Record<string, ResolvedEntitySpec>,
      context: CreateContext,
    ) {
      return createEntities(prisma, spec, context)
    },

    async teardown(scopeValue: string, refs?: Record<string, Record<string, unknown>[]>) {
      const schema = this.getSchema()
      return teardown(prisma, schema, scopeValue, refs)
    },
  }
}
