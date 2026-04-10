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

    // Partition sorted nodes: those that depend on cycle nodes must be deleted
    // BEFORE cycles, those that cycle nodes depend on must be deleted AFTER.
    const cycleNodeSet = new Set(cycles.flat())
    if (cycleNodeSet.size > 0) {
      // Build dependency map: node → set of nodes it depends on
      const dependsOn = new Map<string, Set<string>>()
      for (const edge of schema.edges) {
        if (edge.from !== edge.to) {
          if (!dependsOn.has(edge.from)) dependsOn.set(edge.from, new Set())
          dependsOn.get(edge.from)!.add(edge.to)
        }
      }

      // Mark nodes that transitively depend on cycle nodes. Iterate in sorted
      // (creation) order so transitive deps are already marked when we reach them.
      const dependsOnCycle = new Set<string>()
      for (const node of sorted) {
        const deps = dependsOn.get(node)
        if (deps) {
          for (const dep of deps) {
            if (cycleNodeSet.has(dep) || dependsOnCycle.has(dep)) {
              dependsOnCycle.add(node)
              break
            }
          }
        }
      }

      // cycleDependents: sorted nodes that depend on cycle → delete BEFORE cycle
      // cycleDeps: sorted nodes that cycle depends on → delete AFTER cycle
      const cycleDependents = sorted.filter((n) => dependsOnCycle.has(n))
      const cycleDeps = sorted.filter((n) => !dependsOnCycle.has(n))

      for (const model of [...cycleDependents].reverse()) {
        if (model === scopeRootModel) continue
        await deleteModel(tx, dialect, tableMap, columnMaps, model, scopeValue, scopeFieldByModel, refs, schema)
      }

      for (const cycle of cycles) {
        for (const model of cycle) {
          await deleteModel(tx, dialect, tableMap, columnMaps, model, scopeValue, scopeFieldByModel, refs, schema)
        }
      }

      for (const model of [...cycleDeps].reverse()) {
        if (model === scopeRootModel) continue
        await deleteModel(tx, dialect, tableMap, columnMaps, model, scopeValue, scopeFieldByModel, refs, schema)
      }
    } else {
      // No cycles — simple reverse topo order
      for (const model of [...sorted].reverse()) {
        if (model === scopeRootModel) continue
        await deleteModel(tx, dialect, tableMap, columnMaps, model, scopeValue, scopeFieldByModel, refs, schema)
      }
    }

    // Delete the scope root entity last
    if (scopeRootModel) {
      const dbTable = tableMap.get(scopeRootModel)
      const colMap = columnMaps.get(scopeRootModel) ?? new Map<string, string>()
      if (dbTable) {
        const rootModelInfo = schema.models.find((m) => m.name === scopeRootModel)
        const rootIdFields = rootModelInfo?.fields.filter((f) => f.isId) ?? []
        const rootPkFieldName = (rootIdFields.find((f) => f.name.toLowerCase() === 'id') ?? rootIdFields[0])?.name ?? 'id'
        const idCol = colMap.get(rootPkFieldName) ?? rootPkFieldName
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
  refs: Record<string, Record<string, unknown>[]> | undefined,
  schema: SchemaInfo,
): Promise<void> {
  const dbTable = tableMap.get(model)
  if (!dbTable) return
  const colMap = columnMaps.get(model) ?? new Map<string, string>()

  // Find actual PK field name from schema
  const modelInfo = schema.models.find((m) => m.name === model)
  const idFields = modelInfo?.fields.filter((f) => f.isId) ?? []
  const pkFieldName = (idFields.find((f) => f.name.toLowerCase() === 'id') ?? idFields[0])?.name ?? 'id'

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
      .map((r) => r[pkFieldName])
      .filter((id): id is string | number => id != null)
    if (ids.length > 0) {
      const idCol = colMap.get(pkFieldName) ?? pkFieldName
      const placeholders = ids.map((_, i) => dialect.param(i + 1)).join(', ')
      await tx.query(
        `DELETE FROM ${dialect.quoteId(dbTable)} WHERE ${dialect.quoteId(idCol)} IN (${placeholders})`,
        ids,
      )
    }
  }
}
