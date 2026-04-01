import type { SQLExecutor, SchemaInfo } from './types'
import type { Dialect } from './dialect'
import { topoSort, findDeferrableEdge } from './graph'

/**
 * Tear down all data scoped to a value, in reverse topological order.
 *
 * Strategy:
 *   1. Find the scope root model (e.g. Organization) from FK edges
 *   2. Any model with a FK pointing to the scope root is "scoped"
 *   3. Delete scoped models by their FK = scopeValue
 *   4. Delete non-scoped models by their record IDs from refs
 *   5. Delete the scope root entity last by id = scopeValue
 */
export async function teardown(
  executor: SQLExecutor,
  dialect: Dialect,
  tableMap: Map<string, string>,
  columnMaps: Map<string, Map<string, string>>,
  schema: SchemaInfo,
  scopeValue: string,
  refs?: Record<string, Record<string, unknown>[]>,
): Promise<void> {
  // Find scope root: the model that the scopeField FK points TO
  let scopeRootModel: string | null = null
  for (const edge of schema.edges) {
    if (edge.localField.toLowerCase() === schema.scopeField.toLowerCase() && edge.to !== edge.from) {
      scopeRootModel = edge.to
      break
    }
  }

  // Build map: model → FK field name that points to the scope root
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

  await executor.transaction(async (tx) => {
    // Break cycles by nullifying deferrable FKs
    for (const cycle of cycles) {
      const edge = findDeferrableEdge(cycle, schema.edges)
      if (edge) {
        const scopeFK = scopeFieldByModel.get(edge.from)
        if (scopeFK) {
          const dbTable = tableMap.get(edge.from)
          const colMap = columnMaps.get(edge.from) ?? new Map<string, string>()
          if (dbTable) {
            const dbFKCol = colMap.get(edge.localField) ?? edge.localField
            const dbScopeCol = colMap.get(scopeFK) ?? scopeFK
            await tx.query(
              `UPDATE ${dialect.quoteId(dbTable)} SET ${dialect.quoteId(dbFKCol)} = NULL WHERE ${dialect.quoteId(dbScopeCol)} = ${dialect.param(1)}`,
              [scopeValue],
            )
          }
        }
      }
    }

    // Delete cycle nodes
    for (const cycle of cycles) {
      for (const model of cycle) {
        await deleteModel(tx, dialect, tableMap, columnMaps, model, scopeValue, scopeFieldByModel, refs)
      }
    }

    // Delete in reverse topo order (dependents first)
    const reversed = [...sorted].reverse()
    for (const model of reversed) {
      if (model === scopeRootModel) continue // deleted last
      await deleteModel(tx, dialect, tableMap, columnMaps, model, scopeValue, scopeFieldByModel, refs)
    }

    // Delete the scope root entity last
    if (scopeRootModel) {
      const dbTable = tableMap.get(scopeRootModel)
      const colMap = columnMaps.get(scopeRootModel) ?? new Map<string, string>()
      if (dbTable) {
        const idCol = colMap.get('id') ?? 'id'
        await tx.query(
          `DELETE FROM ${dialect.quoteId(dbTable)} WHERE ${dialect.quoteId(idCol)} = ${dialect.param(1)}`,
          [scopeValue],
        )
      }
    }
  })
}

async function deleteModel(
  tx: SQLExecutor,
  dialect: Dialect,
  tableMap: Map<string, string>,
  columnMaps: Map<string, Map<string, string>>,
  model: string,
  scopeValue: string,
  scopeFieldByModel: Map<string, string>,
  refs?: Record<string, Record<string, unknown>[]>,
): Promise<void> {
  const dbTable = tableMap.get(model)
  if (!dbTable) return
  const colMap = columnMaps.get(model) ?? new Map<string, string>()

  const scopeFK = scopeFieldByModel.get(model)
  if (scopeFK) {
    // Has FK to scope root → delete by that FK
    const dbCol = colMap.get(scopeFK) ?? scopeFK
    await tx.query(
      `DELETE FROM ${dialect.quoteId(dbTable)} WHERE ${dialect.quoteId(dbCol)} = ${dialect.param(1)}`,
      [scopeValue],
    )
  } else if (refs?.[model]) {
    // No FK to scope root, but we created records → delete by IDs
    const ids = refs[model]
      .map((r) => r.id)
      .filter((id): id is string => typeof id === 'string')
    if (ids.length > 0) {
      const idCol = colMap.get('id') ?? 'id'
      const placeholders = ids.map((_, i) => dialect.param(i + 1)).join(', ')
      await tx.query(
        `DELETE FROM ${dialect.quoteId(dbTable)} WHERE ${dialect.quoteId(idCol)} IN (${placeholders})`,
        ids,
      )
    }
  }
}
