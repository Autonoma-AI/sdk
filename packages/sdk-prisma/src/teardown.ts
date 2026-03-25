import type { SchemaInfo, FKEdge } from '@autonoma/sdk'
import { topoSort, findDeferrableEdge } from '@autonoma/sdk'

type PrismaClient = Record<string, any>

/**
 * Tear down all data scoped to a value, in reverse topological order.
 *
 * Strategy:
 *   1. Find the scope root model (e.g. Organization) from FK edges
 *   2. Any model with a FK pointing to the scope root is a "scoped model"
 *   3. Delete scoped models by their FK = scopeValue (regardless of field name casing)
 *   4. Delete non-scoped models by their record IDs from refs
 *   5. Delete the scope root entity last by id = scopeValue
 */
export async function teardown(
  prisma: PrismaClient,
  schema: SchemaInfo,
  scopeValue: string,
  refs?: Record<string, Record<string, unknown>[]>,
): Promise<void> {
  // Find scope root: the model that the scopeField FK points TO
  // e.g. scopeField = "organizationID", edges have { to: "Organization" } → root is Organization
  let scopeRootModel: string | null = null
  for (const edge of schema.edges) {
    if (edge.localField.toLowerCase() === schema.scopeField.toLowerCase() && edge.to !== edge.from) {
      scopeRootModel = edge.to
      break
    }
  }

  // Build map: model → FK field name that points to the scope root
  // Handles mixed casing (organizationId vs organizationID)
  const scopeFieldByModel = new Map<string, string>()
  if (scopeRootModel) {
    for (const edge of schema.edges) {
      if (edge.to === scopeRootModel && edge.from !== scopeRootModel) {
        scopeFieldByModel.set(edge.from, edge.localField)
      }
    }
  }

  const modelNames = schema.models.map((m) => m.name)
  const { sorted, cycles } = topoSort(modelNames, schema.edges)

  await prisma.$transaction(async (tx: PrismaClient) => {
    // Break cycles
    for (const cycle of cycles) {
      const edge = findDeferrableEdge(cycle, schema.edges)
      if (edge) {
        const scopeFK = scopeFieldByModel.get(edge.from)
        if (scopeFK) {
          const delegate = tx[camelCase(edge.from)]
          if (delegate) {
            await delegate.updateMany({
              where: { [scopeFK]: scopeValue },
              data: { [edge.localField]: null },
            })
          }
        }
      }
    }

    // Delete cycle nodes
    for (const cycle of cycles) {
      for (const model of cycle) {
        await deleteModel(tx, model, scopeValue, scopeFieldByModel, refs)
      }
    }

    // Delete in reverse topo order (dependents first)
    const reversed = [...sorted].reverse()
    for (const model of reversed) {
      if (model === scopeRootModel) continue // deleted last
      await deleteModel(tx, model, scopeValue, scopeFieldByModel, refs)
    }

    // Delete the scope root entity last
    if (scopeRootModel) {
      const delegate = tx[camelCase(scopeRootModel)]
      if (delegate) {
        await delegate.deleteMany({ where: { id: scopeValue } })
      }
    }
  })
}

async function deleteModel(
  tx: PrismaClient,
  model: string,
  scopeValue: string,
  scopeFieldByModel: Map<string, string>,
  refs?: Record<string, Record<string, unknown>[]>,
): Promise<void> {
  const delegate = tx[camelCase(model)]
  if (!delegate) {
    return
  }

  const scopeFK = scopeFieldByModel.get(model)
  if (scopeFK) {
    // Has FK to scope root → delete by that FK
    await delegate.deleteMany({ where: { [scopeFK]: scopeValue } })
  } else if (refs?.[model]) {
    // No FK to scope root, but we created records → delete by IDs
    const ids = refs[model]
      .map((r) => r.id)
      .filter((id): id is string => typeof id === 'string')
    if (ids.length > 0) {
      await delegate.deleteMany({ where: { id: { in: ids } } })
    }
  }
}

function camelCase(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1)
}
