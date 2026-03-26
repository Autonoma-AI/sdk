import type { ResolvedEntitySpec, CreateContext } from '@autonoma-ai/sdk'

type PrismaClient = Record<string, any>

/**
 * Create entities using Prisma client.
 *
 * - Normal mode: individual create() calls, returns all created records (available in refs)
 * - Batch mode: single createMany() call, much faster for large counts but returns empty array
 */
export async function createEntities(
  prisma: PrismaClient,
  spec: Record<string, ResolvedEntitySpec>,
  _context: CreateContext,
): Promise<Record<string, Record<string, unknown>[]>> {
  const results: Record<string, Record<string, unknown>[]> = {}

  await prisma.$transaction(async (tx: PrismaClient) => {
    for (const [model, entitySpec] of Object.entries(spec)) {
      const delegate = tx[camelCase(model)]
      if (!delegate) {
        throw new Error(`Prisma model '${model}' not found. Check model name casing.`)
      }

      if (entitySpec.batch) {
        // Batch: single createMany call — fast, but no records returned
        await delegate.createMany({ data: entitySpec.fields })
        results[model] = []
      } else {
        // Normal: individual creates — returns records for refs
        const created: Record<string, unknown>[] = []
        for (const fields of entitySpec.fields) {
          const record = await delegate.create({ data: fields })
          created.push(record)
        }
        results[model] = created
      }
    }
  })

  return results
}

function camelCase(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1)
}
