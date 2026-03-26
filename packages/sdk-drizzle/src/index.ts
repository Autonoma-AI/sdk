import type { OrmAdapter, SchemaInfo, ResolvedEntitySpec, CreateContext } from '@autonoma-ai/sdk'
import { introspectDrizzle, type DrizzleAdapterConfig } from './introspect'
import { createEntities } from './create'
import { teardown } from './teardown'

export type { DrizzleAdapterConfig }

/**
 * Create a Drizzle ORM adapter for the Autonoma SDK.
 *
 * @example
 * ```ts
 * import { drizzleAdapter } from '@autonoma-ai/sdk-drizzle'
 * import { db } from '~/db'
 * import * as schema from '~/db/schema'
 *
 * const adapter = drizzleAdapter(db, schema, { scopeField: 'organizationId' })
 * ```
 */
export function drizzleAdapter(
  db: any,
  schema: Record<string, unknown>,
  config: DrizzleAdapterConfig,
): OrmAdapter {
  let cachedSchema: SchemaInfo | null = null
  const tableMap = buildTableMap(schema)

  return {
    getSchema() {
      if (!cachedSchema) {
        cachedSchema = introspectDrizzle(schema, config)
      }
      return cachedSchema
    },

    async createEntities(
      spec: Record<string, ResolvedEntitySpec>,
      context: CreateContext,
    ) {
      return createEntities(db, tableMap, spec, context)
    },

    async teardown(scopeValue: string) {
      const schemaInfo = this.getSchema()
      // Import eq from drizzle-orm dynamically
      const { eq } = await import('drizzle-orm')
      return teardown(db, tableMap, schemaInfo, scopeValue, eq)
    },

    async updateEntity(model: string, id: string, fields: Record<string, unknown>) {
      const table = tableMap.get(model)
      if (!table) throw new Error(`Model "${model}" not found in Drizzle schema`)
      const { eq } = await import('drizzle-orm')
      await db.update(table).set(fields).where(eq((table as any).id, id))
    },
  }
}

function buildTableMap(schema: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>()
  for (const [key, value] of Object.entries(schema)) {
    if (isTable(value)) {
      // Use the Drizzle table name or the export key
      const name = getTableName(value, key)
      map.set(name, value)
    }
  }
  return map
}

function isTable(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string | symbol, unknown>
  return (
    Symbol.for('drizzle:Name') in v ||
    (v._ != null && typeof v._ === 'object' && 'columns' in (v._ as object))
  )
}

function getTableName(table: unknown, fallback: string): string {
  const sym = Symbol.for('drizzle:Name')
  if (table && typeof table === 'object' && sym in table) {
    return (table as any)[sym] as string
  }
  const t = table as any
  if (t._?.name) return t._.name
  return fallback
}
