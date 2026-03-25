import type { ResolvedEntitySpec, CreateContext } from '@autonoma/sdk'

type DrizzleDB = Record<string, any> & {
  insert(table: any): { values(data: any): { returning(): Promise<any[]> } }
}

/**
 * Create entities using Drizzle ORM.
 */
export async function createEntities(
  db: DrizzleDB,
  tableMap: Map<string, unknown>,
  spec: Record<string, ResolvedEntitySpec>,
  _context: CreateContext,
): Promise<Record<string, Record<string, unknown>[]>> {
  const results: Record<string, Record<string, unknown>[]> = {}

  for (const [model, entitySpec] of Object.entries(spec)) {
    const table = tableMap.get(model)
    if (!table) {
      throw new Error(`Drizzle table '${model}' not found in schema.`)
    }

    const created: Record<string, unknown>[] = []
    for (const fields of entitySpec.fields) {
      const [record] = await db.insert(table).values(fields).returning()
      if (record) created.push(record)
    }
    results[model] = created
  }

  return results
}
