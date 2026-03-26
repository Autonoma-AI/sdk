import type { SchemaInfo, ModelInfo, FieldInfo, FKEdge, SchemaRelation } from '@autonoma-ai/sdk'

interface PrismaClient {
  _runtimeDataModel?: { models: Record<string, DMMFModel> }
  _baseDmmf?: { datamodel: { models: DMMFModel[] } }
}

interface DMMFModel {
  name: string
  fields: DMMFField[]
}

interface DMMFField {
  name: string
  type: string
  kind: string
  isList?: boolean
  isRequired?: boolean
  isId?: boolean
  hasDefaultValue?: boolean
  isUpdatedAt?: boolean
  isGenerated?: boolean
  relationFromFields?: string[]
  relationToFields?: string[]
  relationName?: string
}

export interface PrismaAdapterConfig {
  scopeField: string
}

/**
 * Introspect Prisma DMMF to extract schema metadata.
 * Supports Prisma 5/6 (full DMMF) and Prisma 7+ (stripped _runtimeDataModel, uses inference).
 */
export function introspectPrisma(
  prisma: PrismaClient,
  config: PrismaAdapterConfig,
): SchemaInfo {
  const dmmfModels = getDMMFModels(prisma)

  // Prisma 7+ stripped relationFromFields/relationToFields from _runtimeDataModel.
  // Detect by checking if any object field still carries that metadata.
  const hasDMMFRelationMeta = dmmfModels.some((m) =>
    m.fields.some((f) => f.kind === 'object' && f.relationFromFields !== undefined),
  )

  const models: ModelInfo[] = []
  const edges: FKEdge[] = []
  const relations: SchemaRelation[] = []

  // Extract scalar/enum fields for every model
  for (const model of dmmfModels) {
    const fields: FieldInfo[] = []
    for (const field of model.fields) {
      if (field.kind !== 'scalar' && field.kind !== 'enum') continue
      const { isId, hasDefault, isRequired } = hasDMMFRelationMeta
        ? {
            isId: field.isId ?? false,
            hasDefault:
              field.hasDefaultValue || !!field.isUpdatedAt || !!field.isGenerated || false,
            isRequired: field.isRequired ?? true,
          }
        : inferFieldMetadata(field)
      fields.push({ name: field.name, type: field.type, isRequired, isId, hasDefault })
    }
    models.push({ name: model.name, fields })
  }

  if (hasDMMFRelationMeta) {
    buildEdgesFromDMMF(dmmfModels, edges)
    buildRelationsFromDMMF(dmmfModels, edges, relations)
  } else {
    buildEdgesFromInference(dmmfModels, edges)
    buildRelationsFromInference(dmmfModels, edges, relations)
  }

  return { models, edges, relations, scopeField: config.scopeField }
}

// ---------------------------------------------------------------------------
// Prisma 7+: inference-based FK detection
// ---------------------------------------------------------------------------

/**
 * Infer isId / hasDefault / isRequired from field name + type conventions.
 * Used when Prisma 7 strips those attributes from _runtimeDataModel.
 */
function inferFieldMetadata(field: DMMFField): {
  isId: boolean
  hasDefault: boolean
  isRequired: boolean
} {
  const isId = field.name === 'id'
  const isAutoTimestamp =
    (field.name === 'createdAt' ||
      field.name === 'updatedAt' ||
      field.name.endsWith('At')) &&
    field.type === 'DateTime'
  const hasDefault = isId || isAutoTimestamp
  return { isId, hasDefault, isRequired: !hasDefault }
}

/**
 * Infer FK edges from scalar field names.
 * For an object field `organization: Organization`, if the same model has a scalar
 * field named `organizationId` or `organizationId` (lowerFirst(type) + "Id"),
 * that scalar is the FK.
 */
function buildEdgesFromInference(dmmfModels: DMMFModel[], edges: FKEdge[]): void {
  for (const model of dmmfModels) {
    const scalarNames = new Set(
      model.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => f.name),
    )

    for (const field of model.fields) {
      if (field.kind !== 'object') continue
      const fkField = findFKField(field, scalarNames)
      if (fkField) {
        edges.push({
          from: model.name,
          to: field.type,
          localField: fkField,
          foreignField: 'id',
          nullable: false,
        })
      }
    }
  }
}

/**
 * Build parent→child relation mappings using inferred edges.
 * - Child side (has scalar FK): parentModel=thisModel, childModel=field.type
 * - Parent side (no scalar FK): find the edge on the child model pointing back here
 */
function buildRelationsFromInference(
  dmmfModels: DMMFModel[],
  edges: FKEdge[],
  relations: SchemaRelation[],
): void {
  for (const model of dmmfModels) {
    const scalarNames = new Set(
      model.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => f.name),
    )

    for (const field of model.fields) {
      if (field.kind !== 'object') continue
      const fkField = findFKField(field, scalarNames)

      if (fkField) {
        // This model is the child — it holds the FK pointing to field.type
        relations.push({
          parentModel: model.name,
          childModel: field.type,
          parentField: field.name,
          childField: fkField,
        })
      } else {
        // This model is the parent — the child holds the FK back to this model
        const childEdge = edges.find((e) => e.from === field.type && e.to === model.name)
        if (childEdge) {
          relations.push({
            parentModel: model.name,
            childModel: field.type,
            parentField: field.name,
            childField: childEdge.localField,
          })
        }
      }
    }
  }
}

/**
 * Given an object field and the set of scalar field names on the same model,
 * return the FK scalar field name if one can be found, or null.
 *
 * Tries (in order):
 *   1. `${fieldName}Id`        e.g. organization → organizationId
 *   2. `${lowerFirst(type)}Id` e.g. Organization → organizationId
 */
function findFKField(field: DMMFField, scalarNames: Set<string>): string | null {
  const byFieldName = `${field.name}Id`
  if (scalarNames.has(byFieldName)) return byFieldName

  const byTypeName = `${lowerFirst(field.type)}Id`
  if (scalarNames.has(byTypeName)) return byTypeName

  return null
}

function lowerFirst(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1)
}

// ---------------------------------------------------------------------------
// Prisma ≤6: DMMF-based FK detection (unchanged original logic)
// ---------------------------------------------------------------------------

function buildEdgesFromDMMF(dmmfModels: DMMFModel[], edges: FKEdge[]): void {
  for (const model of dmmfModels) {
    for (const field of model.fields) {
      if (field.kind === 'object' && field.relationFromFields?.length) {
        edges.push({
          from: model.name,
          to: field.type,
          localField: field.relationFromFields[0]!,
          foreignField: field.relationToFields?.[0] ?? 'id',
          nullable: !field.isRequired,
        })
      }
    }
  }
}

function buildRelationsFromDMMF(
  dmmfModels: DMMFModel[],
  edges: FKEdge[],
  relations: SchemaRelation[],
): void {
  // Parent side: object fields with no relationFromFields (they don't hold the FK)
  for (const model of dmmfModels) {
    for (const field of model.fields) {
      if (field.kind === 'object' && !field.relationFromFields?.length) {
        const childEdge = edges.find(
          (e) => e.from === field.type && e.to === model.name && e.foreignField === 'id',
        )
        const childEdgeByRelation =
          !childEdge
            ? edges.find((e) => {
                if (e.from !== field.type || e.to !== model.name) return false
                const childModel = dmmfModels.find((m) => m.name === field.type)
                if (!childModel) return false
                const childField = childModel.fields.find(
                  (f) =>
                    f.kind === 'object' &&
                    f.relationName === field.relationName &&
                    f.relationFromFields?.length,
                )
                return childField?.relationFromFields?.[0] === e.localField
              })
            : null

        const edge = childEdge ?? childEdgeByRelation
        if (edge) {
          relations.push({
            parentModel: model.name,
            childModel: field.type,
            parentField: field.name,
            childField: edge.localField,
          })
        }
      }
    }
  }

  // Child-side singular relations: object fields that DO hold the FK
  for (const model of dmmfModels) {
    for (const field of model.fields) {
      if (field.kind === 'object' && !field.isList && field.relationFromFields?.length) {
        const localField = field.relationFromFields[0]!
        const alreadyCovered = relations.some(
          (r) => r.parentModel === model.name && r.parentField === field.name,
        )
        if (!alreadyCovered) {
          relations.push({
            parentModel: model.name,
            childModel: field.type,
            parentField: field.name,
            childField: localField,
          })
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// DMMF model extraction
// ---------------------------------------------------------------------------

function getDMMFModels(prisma: PrismaClient): DMMFModel[] {
  if (prisma._runtimeDataModel?.models) {
    return Object.entries(prisma._runtimeDataModel.models).map(([name, model]) => ({
      ...model,
      name,
    }))
  }

  if (prisma._baseDmmf?.datamodel?.models) {
    return prisma._baseDmmf.datamodel.models
  }

  throw new Error(
    'Cannot introspect Prisma schema. Ensure @prisma/client is generated.',
  )
}
