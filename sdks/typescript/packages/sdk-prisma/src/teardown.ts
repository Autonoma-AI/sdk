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

    // Build condensation graph: each SCC is a super-node, each sorted node
    // is its own node. Topo-sort the condensation DAG and delete in reverse
    // order so that dependents of cycles are deleted before the cycle itself.
    const components: string[][] = []
    const nodeToComp = new Map<string, number>()

    for (const cycle of cycles) {
      const idx = components.length
      components.push(cycle)
      for (const node of cycle) nodeToComp.set(node, idx)
    }
    for (const node of sorted) {
      nodeToComp.set(node, components.length)
      components.push([node])
    }

    // Build condensation DAG edges (dependency → dependent)
    const condAdj = new Map<number, Set<number>>()
    const condInDeg = new Map<number, number>()
    for (let i = 0; i < components.length; i++) {
      condAdj.set(i, new Set())
      condInDeg.set(i, 0)
    }
    for (const edge of schema.edges) {
      if (edge.from === edge.to) continue
      const fc = nodeToComp.get(edge.from)
      const tc = nodeToComp.get(edge.to)
      if (fc !== undefined && tc !== undefined && fc !== tc && !condAdj.get(tc)!.has(fc)) {
        condAdj.get(tc)!.add(fc)
        condInDeg.set(fc, (condInDeg.get(fc) ?? 0) + 1)
      }
    }

    // Kahn's algorithm on the condensation DAG
    const condQueue: number[] = []
    for (const [idx, deg] of condInDeg) {
      if (deg === 0) condQueue.push(idx)
    }
    const condOrder: number[] = []
    while (condQueue.length > 0) {
      condQueue.sort()
      const idx = condQueue.shift()!
      condOrder.push(idx)
      for (const neighbor of condAdj.get(idx)!) {
        const nd = (condInDeg.get(neighbor) ?? 1) - 1
        condInDeg.set(neighbor, nd)
        if (nd === 0) condQueue.push(neighbor)
      }
    }

    // Delete in reverse condensation order (dependents first)
    for (const compIdx of [...condOrder].reverse()) {
      for (const model of components[compIdx]) {
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
