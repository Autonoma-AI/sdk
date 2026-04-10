import type { SchemaInfo, SchemaRelation } from './types'

const RESERVED_KEYS = new Set(['_alias', '_ref'])

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
  ): string {
    const fields: Record<string, unknown> = {}
    const preChildren: Array<{ relation: SchemaRelation; value: unknown; fkOnParent: boolean }> = []
    const postChildren: Array<{ relation: SchemaRelation; value: unknown; fkOnParent: boolean }> = []
    const alias = node._alias as string | undefined
    const tempId = makeTempId(modelName)

    for (const [key, value] of Object.entries(node)) {
      if (RESERVED_KEYS.has(key)) continue

      // Look up relation by exact key, then try fallbacks:
      // 1. Model name prefix: Test.steps → Test.testSteps (Prisma abbreviated names)
      // 2. Child model name: Organization.Application → Organization.applications
      //    (scenarios using PascalCase model names as relation keys)
      const exactKey = `${modelName}.${key}`
      const prefixedKey = `${modelName}.${modelName.charAt(0).toLowerCase()}${modelName.slice(1)}${key.charAt(0).toUpperCase()}${key.slice(1)}`
      let relation = relationByParentField.get(exactKey) ?? relationByParentField.get(prefixedKey) ?? undefined
      let matchedKey = relationByParentField.has(exactKey) ? exactKey : prefixedKey
      if (!relation) {
        // Fallback: match by child model name (PascalCase keys like Application, Tag)
        for (const [relKey, rel] of relationByParentField) {
          if (relKey.startsWith(`${modelName}.`) && rel.childModel.toLowerCase() === key.toLowerCase()) {
            relation = rel
            matchedKey = relKey
            break
          }
        }
      }
      if (relation) {
        const isOnParent = fkOnParent.has(matchedKey)
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

      fields[key] = value
    }

    // Wire FK to parent (if this node is a child and FK is on the child)
    if (parentRelation && parentTempId && !parentFkOnParent) {
      fields[parentRelation.childField] = parentTempId
    }

    // Process pre-children: these need to be created BEFORE this node
    // because this node's FK points to them
    for (const { relation, value } of preChildren) {
      if (Array.isArray(value)) {
        for (const item of value) {
          const childTempId = walkNode(relation.childModel, item as Record<string, unknown>, tempId, relation, true)
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
        for (const item of value) {
          walkNode(relation.childModel, item as Record<string, unknown>, tempId, relation, false)
        }
      }
    }

    return tempId
  }

  for (const [modelName, nodes] of Object.entries(create)) {
    for (const node of nodes) {
      walkNode(modelName, node, null, null, false)
    }
  }

  return { ops, deferredUpdates, aliases }
}
