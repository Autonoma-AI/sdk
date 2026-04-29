/**
 * Resolve the create payload into an ordered list of operations.
 *
 * The old SDK derived ordering from a static FK schema introspected from
 * the database. With factories owning entity creation the SDK no longer
 * has — or needs — that schema. What it does have is the create payload
 * itself, and that already contains complete dependency information:
 *
 *   * Each entity that other entities depend on declares `_alias: "name"`.
 *   * Each entity that depends on another carries `{ _ref: "name" }`
 *     somewhere in its field tree (top-level FK, nested data blob, list
 *     element — anywhere).
 *
 * Walking the payload to collect alias → owner and owner → {refs} gives
 * us the exact dependency graph. Kahn's topo sort over that graph
 * produces the `up` order; the reverse is the `down` order.
 *
 * Cycles in the alias graph raise INVALID_BODY. The old SDK used to
 * break cycles by nullifying nullable FKs; with factories the host owns
 * FK semantics and the SDK does not modify rows, so we surface cycles
 * to the caller instead.
 */
import { Errors } from './errors'

export interface CreateOp {
  model: string
  fields: Record<string, unknown>
  tempId: string
}

export interface ResolvedTree {
  ops: CreateOp[]
  /** alias → temp id assigned to the entity declaring that alias. */
  aliases: Record<string, string>
  /** alias → model name, used by teardown to pick the right factory. */
  aliasOwnerModel: Record<string, string>
  /** alias → list of aliases the owner depends on (may include unknowns). */
  aliasDependencies: Record<string, string[]>
}

const RESERVED_KEYS = new Set(['_alias', '_ref'])

function collectRefs(value: unknown, out: string[]): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const ref = obj._ref
    if (typeof ref === 'string') {
      out.push(ref)
      return
    }
    for (const v of Object.values(obj)) collectRefs(v, out)
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out)
  }
}

function resolveRefs(value: unknown, aliasToTempId: Record<string, string>): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const ref = obj._ref
    if (typeof ref === 'string') {
      const real = aliasToTempId[ref]
      return real !== undefined ? real : value
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = resolveRefs(v, aliasToTempId)
    }
    return out
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveRefs(v, aliasToTempId))
  }
  return value
}

/**
 * Topo-sort a create payload into an ordered list of `CreateOp`.
 *
 * `create` is the dashboard's nested map `{ model: [entity, ...] }`.
 * Each entity is an object; `_alias` (declared by dependency targets)
 * and `_ref` (declared by dependents, anywhere in the field tree) are
 * the only reserved keys.
 *
 * Throws INVALID_BODY if the payload references an alias that is never
 * declared, or if the alias graph contains a cycle.
 */
export function resolvePayloadTree(
  create: Record<string, unknown>,
): ResolvedTree {
  if (!create || typeof create !== 'object' || Array.isArray(create)) {
    throw Errors.invalidBody('`create` must be an object keyed by model name')
  }

  // First pass: assign temp ids and collect alias declarations.
  type RawEntry = {
    model: string
    tempId: string
    entity: Record<string, unknown>
    alias: string | null
  }

  const rawEntries: RawEntry[] = []
  let counter = 0
  const aliases: Record<string, string> = {}
  const aliasOwnerModel: Record<string, string> = {}

  for (const [model, entities] of Object.entries(create as Record<string, unknown>)) {
    if (!Array.isArray(entities)) {
      throw Errors.invalidBody(
        `\`create.${model}\` must be a list of entity objects, got ${typeof entities}`,
      )
    }
    for (const entity of entities) {
      if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
        throw Errors.invalidBody(
          `\`create.${model}\` entries must be objects, got ${Array.isArray(entity) ? 'array' : typeof entity}`,
        )
      }
      const tempId = `__temp_${model}_${counter++}`
      const obj = entity as Record<string, unknown>
      const aliasRaw = obj._alias
      let alias: string | null = null
      if (typeof aliasRaw === 'string') {
        if (aliases[aliasRaw] !== undefined) {
          throw Errors.invalidBody(`duplicate _alias "${aliasRaw}"`)
        }
        aliases[aliasRaw] = tempId
        aliasOwnerModel[aliasRaw] = model
        alias = aliasRaw
      } else if (aliasRaw !== undefined && aliasRaw !== null) {
        throw Errors.invalidBody('"_alias" must be a string')
      }
      rawEntries.push({ model, tempId, entity: obj, alias })
    }
  }

  // Second pass: collect each entry's dependency aliases (for the topo
  // graph) and strip reserved keys from its field dict.
  const depsByTempId: Record<string, string[]> = {}
  const fieldsByTempId: Record<string, Record<string, unknown>> = {}
  const modelByTempId: Record<string, string> = {}

  for (const { model, tempId, entity } of rawEntries) {
    const deps: string[] = []
    const cleaned: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(entity)) {
      if (RESERVED_KEYS.has(key)) continue
      collectRefs(value, deps)
      // Rewrite every `{ _ref: alias }` to the alias's temp id. The
      // handler later swaps temp ids for the real factory-returned ids
      // during `up`.
      cleaned[key] = resolveRefs(value, aliases)
    }
    const unknowns = deps.filter((a) => aliases[a] === undefined)
    if (unknowns.length > 0) {
      const sorted = Array.from(new Set(unknowns)).sort()
      throw Errors.invalidBody(
        `\`create.${model}\` references unknown alias(es): ${sorted.join(', ')}`,
      )
    }
    depsByTempId[tempId] = deps
    fieldsByTempId[tempId] = cleaned
    modelByTempId[tempId] = model
  }

  // Build the temp_id graph and topo-sort.
  const inDegree: Record<string, number> = {}
  for (const { tempId } of rawEntries) inDegree[tempId] = 0
  const edges: Record<string, string[]> = {}
  for (const [tempId, deps] of Object.entries(depsByTempId)) {
    const seen = new Set<string>()
    for (const depAlias of deps) {
      const depTempId = aliases[depAlias]!
      if (depTempId === tempId || seen.has(depTempId)) continue
      seen.add(depTempId)
      ;(edges[depTempId] ??= []).push(tempId)
      inDegree[tempId] = (inDegree[tempId] ?? 0) + 1
    }
  }

  // Kahn's, preserving payload order as the stable tie-breaker.
  const payloadOrder: Record<string, number> = {}
  rawEntries.forEach((e, i) => {
    payloadOrder[e.tempId] = i
  })

  const ready = Object.keys(inDegree)
    .filter((t) => inDegree[t] === 0)
    .sort((a, b) => payloadOrder[a]! - payloadOrder[b]!)

  const sortedTempIds: string[] = []
  while (ready.length > 0) {
    const tid = ready.shift()!
    sortedTempIds.push(tid)
    for (const next of edges[tid] ?? []) {
      inDegree[next] = (inDegree[next] ?? 0) - 1
      if (inDegree[next] === 0) ready.push(next)
    }
    ready.sort((a, b) => payloadOrder[a]! - payloadOrder[b]!)
  }

  if (sortedTempIds.length !== rawEntries.length) {
    const cycle = Object.entries(inDegree)
      .filter(([, deg]) => deg > 0)
      .map(([tid]) => tid)
      .sort((a, b) => payloadOrder[a]! - payloadOrder[b]!)
    const cycleModels = cycle.map((t) => modelByTempId[t]).join(', ')
    throw Errors.invalidBody(`cycle detected in _alias/_ref graph: ${cycleModels}`)
  }

  // Build CreateOp list in topo order.
  const aliasDependencies: Record<string, string[]> = {}
  for (const [alias, tempId] of Object.entries(aliases)) {
    aliasDependencies[alias] = [...(depsByTempId[tempId] ?? [])]
  }

  const ops: CreateOp[] = sortedTempIds.map((tid) => ({
    model: modelByTempId[tid]!,
    fields: fieldsByTempId[tid]!,
    tempId: tid,
  }))

  return { ops, aliases, aliasOwnerModel, aliasDependencies }
}

/**
 * Order models for teardown.
 *
 * With `aliasDependencies` available (newer refs tokens carry it), we
 * run the same Kahn's topo sort over models — derived from aggregating
 * each alias's dependencies — and return the *reverse* topo so children
 * are torn down before parents.
 *
 * Without it (older refs tokens), fall back to reversing the insertion
 * order of `refs` keys, which is what the SDK always did for factory
 * teardown.
 */
export function computeTeardownOrder(
  refs: Record<string, unknown[]>,
  aliasDependencies?: Record<string, string[]>,
  aliasOwnerModel?: Record<string, string>,
): string[] {
  const models = Object.keys(refs)

  if (!aliasDependencies || !aliasOwnerModel || Object.keys(aliasDependencies).length === 0) {
    return [...models].reverse()
  }

  const modelDeps: Record<string, Set<string>> = {}
  for (const m of models) modelDeps[m] = new Set()

  for (const [alias, deps] of Object.entries(aliasDependencies)) {
    const owner = aliasOwnerModel[alias]
    if (!owner || !(owner in modelDeps)) continue
    for (const depAlias of deps) {
      const depModel = aliasOwnerModel[depAlias]
      if (!depModel || depModel === owner) continue
      if (depModel in modelDeps) {
        modelDeps[owner]!.add(depModel)
      }
    }
  }

  const inDegree: Record<string, number> = {}
  for (const m of models) inDegree[m] = 0
  const adj: Record<string, string[]> = {}
  for (const [owner, deps] of Object.entries(modelDeps)) {
    for (const depModel of deps) {
      ;(adj[depModel] ??= []).push(owner)
      inDegree[owner] = (inDegree[owner] ?? 0) + 1
    }
  }

  const payloadOrder: Record<string, number> = {}
  models.forEach((m, i) => {
    payloadOrder[m] = i
  })

  const ready = models
    .filter((m) => inDegree[m] === 0)
    .sort((a, b) => payloadOrder[a]! - payloadOrder[b]!)
  const upOrder: string[] = []
  while (ready.length > 0) {
    const m = ready.shift()!
    upOrder.push(m)
    for (const next of adj[m] ?? []) {
      inDegree[next] = (inDegree[next] ?? 0) - 1
      if (inDegree[next] === 0) ready.push(next)
    }
    ready.sort((a, b) => payloadOrder[a]! - payloadOrder[b]!)
  }

  if (upOrder.length !== models.length) {
    // Shouldn't happen — cycles are rejected at `up`. Fall back to
    // registration order to avoid losing data.
    return [...models].reverse()
  }

  return [...upOrder].reverse()
}
