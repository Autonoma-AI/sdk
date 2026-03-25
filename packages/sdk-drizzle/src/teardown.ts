import type { SchemaInfo } from '@autonoma/sdk'
import { topoSort, findDeferrableEdge } from '@autonoma/sdk'

type DrizzleDB = Record<string, any> & {
  delete(table: any): { where(condition: any): Promise<void> }
  update(table: any): { set(data: any): { where(condition: any): Promise<void> } }
}

/**
 * Tear down all data scoped to a value using Drizzle ORM.
 */
export async function teardown(
  db: DrizzleDB,
  tableMap: Map<string, unknown>,
  schema: SchemaInfo,
  scopeValue: string,
  eq: (col: any, val: any) => any,
): Promise<void> {
  const modelNames = schema.models.map((m) => m.name)
  const { sorted, cycles } = topoSort(modelNames, schema.edges)

  // Break cycles by nullifying deferrable FKs
  for (const cycle of cycles) {
    const edge = findDeferrableEdge(cycle, schema.edges)
    if (edge) {
      const table = tableMap.get(edge.from)
      if (table) {
        await db
          .update(table)
          .set({ [edge.localField]: null })
          .where(eq((table as any)[schema.scopeField], scopeValue))
      }
    }
  }

  // Delete cycle nodes
  for (const cycle of cycles) {
    for (const model of cycle) {
      await deleteModel(db, tableMap, model, schema.scopeField, scopeValue, eq)
    }
  }

  // Delete in reverse topo order
  const reversed = [...sorted].reverse()
  for (const model of reversed) {
    await deleteModel(db, tableMap, model, schema.scopeField, scopeValue, eq)
  }
}

async function deleteModel(
  db: DrizzleDB,
  tableMap: Map<string, unknown>,
  model: string,
  scopeField: string,
  scopeValue: string,
  eq: (col: any, val: any) => any,
): Promise<void> {
  const table = tableMap.get(model)
  if (!table) return

  await db.delete(table).where(eq((table as any)[scopeField], scopeValue))
}
