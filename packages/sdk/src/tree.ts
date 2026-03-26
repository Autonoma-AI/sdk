import type { SchemaInfo, SchemaRelation } from './types'
import { resolveTemplate, type TemplateContext } from './template'

const RESERVED_KEYS = new Set(['_alias', '_ref', '_count', '_batch'])

/** A create operation produced by the tree resolver */
export interface CreateOp {
  model: string
  fields: Record<string, unknown>
  tempId: string
  batch: boolean
}

/**
 * A deferred FK update — emitted when a _ref points to a node that hasn't
 * been created yet (circular dependency). Resolved after all creates.
 */
export interface DeferredUpdate {
  /** Temp ID of the record that needs to be updated */
  targetTempId: string
  /** Model name of the record to update */
  model: string
  /** Field on the record that holds the deferred FK */
  field: string
  /** Alias that will resolve to the FK value once created */
  refAlias: string
}

/** Result of resolving a tree scenario */
export interface ResolvedTree {
  ops: CreateOp[]
  deferredUpdates: DeferredUpdate[]
  aliases: Map<string, string>
}

/** A resolved reference to another node's id */
export interface RefNode {
  _ref: string
}

/**
 * Resolve a nested scenario tree into an ordered list of create operations.
 *
 * Walks depth-first. Parent-child FKs are wired automatically.
 * Handles both directions:
 *   - FK on child (Application.organizationId → Organization): set child FK to parent ID
 *   - FK on parent (Member.userId → User): create child first, set parent FK to child ID
 *
 * Circular FK cycles (e.g. Application.mainBranchId ↔ Branch.applicationId) are handled
 * transparently: the nullable FK is omitted on the first create and emitted as a
 * DeferredUpdate to be applied via UPDATE after all records exist.
 */
export function resolveTree(
  create: Record<string, Record<string, unknown>[]>,
  schema: SchemaInfo,
  testRunId: string,
): ResolvedTree {
  const relationByParentField = new Map<string, SchemaRelation>()
  for (const rel of schema.relations) {
    relationByParentField.set(`${rel.parentModel}.${rel.parentField}`, rel)
  }

  // Determine FK direction for each relation:
  // Is childField on the parent model or the child model?
  const fkOnParent = new Set<string>() // key: "parentModel.parentField"
  for (const rel of schema.relations) {
    const edge = schema.edges.find(
      (e) => e.localField === rel.childField && (e.from === rel.parentModel || e.from === rel.childModel),
    )
    if (edge && edge.from === rel.parentModel) {
      // FK column is on the parent model → create child first, then set parent FK
      fkOnParent.add(`${rel.parentModel}.${rel.parentField}`)
    }
  }

  const aliases = new Map<string, string>()
  const ops: CreateOp[] = []
  const deferredUpdates: DeferredUpdate[] = []
  let tempCounter = 0

  function makeTempId(model: string): string {
    return `__temp_${model}_${tempCounter++}`
  }

  function walkNode(
    modelName: string,
    node: Record<string, unknown>,
    parentTempId: string | null,
    parentRelation: SchemaRelation | null,
    parentFkOnParent: boolean,
    index: number,
  ): string {
    const fields: Record<string, unknown> = {}
    const preChildren: Array<{ relation: SchemaRelation; value: unknown; fkOnParent: boolean }> = []
    const postChildren: Array<{ relation: SchemaRelation; value: unknown; fkOnParent: boolean }> = []
    const alias = node._alias as string | undefined
    const tempId = makeTempId(modelName)

    for (const [key, value] of Object.entries(node)) {
      if (RESERVED_KEYS.has(key)) continue

      const relation = relationByParentField.get(`${modelName}.${key}`)
      if (relation) {
        const isOnParent = fkOnParent.has(`${modelName}.${key}`)
        if (isOnParent) {
          // FK is on this model → need to create the child BEFORE this node
          preChildren.push({ relation, value, fkOnParent: true })
        } else {
          // FK is on the child → create child AFTER this node (normal)
          postChildren.push({ relation, value, fkOnParent: false })
        }
        continue
      }

      if (value && typeof value === 'object' && '_ref' in value) {
        const refAlias = (value as RefNode)._ref
        const refTempId = aliases.get(refAlias)
        if (!refTempId) {
          // Alias not created yet — defer this FK as an UPDATE after all creates.
          // This handles circular FK cycles (e.g. Application.mainBranchId → Branch
          // where Branch.applicationId → Application).
          deferredUpdates.push({ targetTempId: tempId, model: modelName, field: key, refAlias })
          continue
        }
        fields[key] = refTempId
        continue
      }

      const ctx: TemplateContext = { testRunId, index, }
      fields[key] = resolveTemplate(value, ctx)
    }

    // Wire FK to parent (if this node is a child and FK is on the child)
    if (parentRelation && parentTempId && !parentFkOnParent) {
      fields[parentRelation.childField] = parentTempId
    }

    // Process pre-children: these need to be created BEFORE this node
    // because this node's FK points to them
    for (const { relation, value, fkOnParent: isOnParent } of preChildren) {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const childTempId = walkNode(relation.childModel, value[i] as Record<string, unknown>, tempId, relation, true, i)
          // Set this node's FK to point to the created child
          fields[relation.childField] = childTempId
        }
      }
    }

    // Create this node
    ops.push({ model: modelName, fields, tempId, batch: false })
    if (alias) aliases.set(alias, tempId)

    // Process post-children: normal case, FK is on the child
    for (const { relation, value } of postChildren) {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          walkNode(relation.childModel, value[i] as Record<string, unknown>, tempId, relation, false, i)
        }
      } else if (value && typeof value === 'object' && '_count' in value) {
        const bulk = value as Record<string, unknown>
        const count = bulk._count as number
        const isBatch = (bulk._batch as boolean) ?? false

        for (let i = 0; i < count; i++) {
          const bulkFields: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(bulk)) {
            if (k === '_count' || k === '_batch') continue
            const ctx: TemplateContext = { testRunId, index: i, }
            bulkFields[k] = resolveTemplate(v, ctx)
          }
          bulkFields[relation.childField] = tempId
          ops.push({ model: relation.childModel, fields: bulkFields, tempId: makeTempId(relation.childModel), batch: isBatch })
        }
      }
    }

    return tempId
  }

  for (const [modelName, nodes] of Object.entries(create)) {
    for (let i = 0; i < nodes.length; i++) {
      walkNode(modelName, nodes[i]!, null, null, false, i)
    }
  }

  return { ops, deferredUpdates, aliases }
}
