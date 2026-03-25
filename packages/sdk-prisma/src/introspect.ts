import type { SchemaInfo, ModelInfo, FieldInfo, FKEdge, SchemaRelation } from '@autonoma/sdk'

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
  isRequired: boolean
  isId: boolean
  hasDefaultValue: boolean
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
 */
export function introspectPrisma(
  prisma: PrismaClient,
  config: PrismaAdapterConfig,
): SchemaInfo {
  const dmmfModels = getDMMFModels(prisma)
  const models: ModelInfo[] = []
  const edges: FKEdge[] = []
  const relations: SchemaRelation[] = []

  // First pass: extract scalar fields and FK edges
  for (const model of dmmfModels) {
    const fields: FieldInfo[] = []

    for (const field of model.fields) {
      if (field.kind === 'object') {
        // FK edge: this model holds a FK pointing to another model
        if (field.relationFromFields?.length) {
          const localField = field.relationFromFields[0]!
          const foreignField = field.relationToFields?.[0] ?? 'id'
          edges.push({
            from: model.name,
            to: field.type,
            localField,
            foreignField,
            nullable: !field.isRequired,
          })
        }
        continue
      }

      if (field.kind === 'enum' || field.kind === 'scalar') {
        fields.push({
          name: field.name,
          type: field.type,
          isRequired: field.isRequired,
          isId: field.isId,
          hasDefault: field.hasDefaultValue || !!field.isUpdatedAt || !!field.isGenerated,
        })
      }
    }

    models.push({ name: model.name, fields })
  }

  // Second pass: extract relation names (parent → child list mappings)
  // A relation field that is a list and has NO relationFromFields means it's the parent side
  for (const model of dmmfModels) {
    for (const field of model.fields) {
      if (field.kind === 'object' && !field.relationFromFields?.length) {
        // This is the parent side of a relation (no FK here):
        // - isList: true → one-to-many (Organization.members → Member[])
        // - isList: false → one-to-one (Application.webApplicationData → WebApplicationData)
        // This is the parent side: e.g. Organization.applications → Application[]
        // Find the corresponding FK edge on the child
        const childEdge = edges.find(
          (e) => e.from === field.type && e.to === model.name && e.foreignField === 'id',
        )
        // Also try matching by relationName
        const childEdgeByRelation = !childEdge
          ? edges.find((e) => {
              if (e.from !== field.type || e.to !== model.name) return false
              // Match via DMMF relation name
              const childModel = dmmfModels.find((m) => m.name === field.type)
              if (!childModel) return false
              const childField = childModel.fields.find(
                (f) => f.kind === 'object' && f.relationName === field.relationName && f.relationFromFields?.length,
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

  // Third pass: extract singular relations where the FK is on the current model
  // e.g. Member.user → User (Member holds userId FK, user is not a list)
  for (const model of dmmfModels) {
    for (const field of model.fields) {
      if (field.kind === 'object' && !field.isList && field.relationFromFields?.length) {
        const localField = field.relationFromFields[0]!
        // Check this isn't already covered by a list relation
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

  return { models, edges, relations, scopeField: config.scopeField }
}

function getDMMFModels(prisma: PrismaClient): DMMFModel[] {
  if (prisma._runtimeDataModel?.models) {
    return Object.entries(prisma._runtimeDataModel.models).map(
      ([name, model]) => ({ ...model, name }),
    )
  }

  if (prisma._baseDmmf?.datamodel?.models) {
    return prisma._baseDmmf.datamodel.models
  }

  throw new Error(
    'Cannot introspect Prisma schema. Ensure @prisma/client is generated.',
  )
}
