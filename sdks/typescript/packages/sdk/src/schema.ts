/**
 * Build the SDK's wire-shape schema from registered factories.
 *
 * The dashboard's `discover` response carries a `schema` block listing
 * every model the host can create. With the old SDK that came from
 * `information_schema` queries; with this one it comes from each
 * factory's `inputSchema` (a Zod schema).
 *
 * The mapping from a Zod type to the dashboard's coarse type string is
 * intentionally lossy — the dashboard only branches on a handful of
 * categories (`string`, `integer`, `boolean`, `timestamp`, ...) and
 * treats everything else as opaque JSON.
 */
import type { ZodTypeAny } from 'zod'

import type {
  FactoryRegistry,
  FieldInfo,
  ModelInfo,
  SchemaInfo,
} from './types'

/**
 * Map a Zod schema to the SDK's coarse type string.
 *
 * Unknown schemas fall back to `string` — the conservative default the
 * dashboard renders as a free-form text input.
 */
export function fieldTypeFromZod(schema: ZodTypeAny): string {
  return classifyZod(unwrap(schema))
}

interface InternalDef {
  typeName?: string
  type?: string
  innerType?: ZodTypeAny
  schema?: ZodTypeAny
  // v3
  options?: ZodTypeAny[]
  // v4 stores variants in different shape; we don't need it.
}

function getDef(schema: ZodTypeAny): InternalDef {
  const def = (schema as { _def?: unknown })._def
  return (def && typeof def === 'object' ? (def as InternalDef) : {})
}

function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let current: ZodTypeAny = schema
  // Defensively cap depth to avoid runaway loops on weird user inputs.
  for (let i = 0; i < 16; i++) {
    const def = getDef(current)
    const wrapped = wrappedSchemaFrom(def)
    if (!wrapped) return current
    current = wrapped
  }
  return current
}

function wrappedSchemaFrom(def: InternalDef): ZodTypeAny | null {
  // Zod v3: ZodOptional/Nullable/Default/Brand/Catch/ReadOnly/Pipeline/Effects
  // expose `innerType` or `schema` on `_def`.
  const candidate = (def.innerType ?? def.schema) as ZodTypeAny | undefined
  if (!candidate) return null
  // Only unwrap for known wrapper kinds; otherwise we would unwrap arrays
  // and objects too aggressively. Type names match Zod v3.
  const tn = def.typeName
  if (
    tn === 'ZodOptional' ||
    tn === 'ZodNullable' ||
    tn === 'ZodDefault' ||
    tn === 'ZodCatch' ||
    tn === 'ZodBranded' ||
    tn === 'ZodReadonly' ||
    tn === 'ZodEffects' ||
    tn === 'ZodPipeline' ||
    tn === 'ZodLazy' ||
    // Zod v4 uses `type` instead of `typeName`.
    def.type === 'optional' ||
    def.type === 'nullable' ||
    def.type === 'default' ||
    def.type === 'catch' ||
    def.type === 'readonly' ||
    def.type === 'pipe' ||
    def.type === 'lazy'
  ) {
    return candidate
  }
  return null
}

function classifyZod(schema: ZodTypeAny): string {
  const def = getDef(schema)
  const name = (def.typeName ?? def.type ?? '').toString()

  if (name === 'ZodString' || name === 'string') return 'string'
  if (name === 'ZodNumber' || name === 'number') {
    // Zod has no first-class integer flag; default to number. Hosts can
    // override by composing `z.number().int()` (still maps to number).
    return 'number'
  }
  if (name === 'ZodBigInt' || name === 'bigint') return 'integer'
  if (name === 'ZodBoolean' || name === 'boolean') return 'boolean'
  if (name === 'ZodDate' || name === 'date') return 'timestamp'
  if (name === 'ZodEnum' || name === 'enum') return 'string'
  if (name === 'ZodNativeEnum' || name === 'nativeEnum') return 'string'
  if (name === 'ZodLiteral' || name === 'literal') return 'string'
  if (
    name === 'ZodArray' ||
    name === 'array' ||
    name === 'ZodObject' ||
    name === 'object' ||
    name === 'ZodRecord' ||
    name === 'record' ||
    name === 'ZodTuple' ||
    name === 'tuple' ||
    name === 'ZodMap' ||
    name === 'map' ||
    name === 'ZodSet' ||
    name === 'set' ||
    name === 'ZodAny' ||
    name === 'any' ||
    name === 'ZodUnknown' ||
    name === 'unknown'
  ) {
    return 'json'
  }
  return 'string'
}

function isOptional(schema: ZodTypeAny): boolean {
  const def = getDef(schema)
  const tn = def.typeName ?? def.type
  if (tn === 'ZodOptional' || tn === 'optional') return true
  if (tn === 'ZodDefault' || tn === 'default') return true
  if (tn === 'ZodNullable' || tn === 'nullable') {
    // `.nullable()` alone still requires the field; only treat as optional
    // when the host also marked it optional or gave it a default.
    return false
  }
  // Recurse through wrappers other than the ones above.
  const inner = wrappedSchemaFrom(def)
  if (inner) return isOptional(inner)
  return false
}

function hasDefault(schema: ZodTypeAny): boolean {
  const def = getDef(schema)
  const tn = def.typeName ?? def.type
  if (tn === 'ZodDefault' || tn === 'default') return true
  const inner = wrappedSchemaFrom(def)
  if (inner) return hasDefault(inner)
  return false
}

function camelToSnake(name: string): string {
  let out = ''
  for (let i = 0; i < name.length; i++) {
    const ch = name.charAt(i)
    if (ch >= 'A' && ch <= 'Z' && i > 0) {
      const prev = name.charAt(i - 1)
      if (!(prev >= 'A' && prev <= 'Z')) {
        out += '_'
      }
    }
    out += ch.toLowerCase()
  }
  return out
}

function objectShape(schema: ZodTypeAny): Record<string, ZodTypeAny> | null {
  const def = getDef(schema)
  const tn = def.typeName ?? def.type
  if (tn !== 'ZodObject' && tn !== 'object') return null
  // Zod v3 stores `shape` as a getter on `_def.shape()`. Zod v4 stores
  // `shape` as an object on `_def.shape`. Cover both.
  const shape = (def as Record<string, unknown>).shape
  if (typeof shape === 'function') {
    try {
      const evaluated = (shape as () => Record<string, ZodTypeAny>)()
      if (evaluated && typeof evaluated === 'object') return evaluated
    } catch {
      return null
    }
  }
  if (shape && typeof shape === 'object') {
    return shape as Record<string, ZodTypeAny>
  }
  return null
}

function modelToFields(inputSchema: ZodTypeAny): FieldInfo[] {
  // Every model gets a synthetic `id` field at the head of the list —
  // factories always mint a primary key, even when the input doesn't
  // declare one.
  const fields: FieldInfo[] = [
    { name: 'id', type: 'string', isRequired: false, isId: true, hasDefault: true },
  ]
  const shape = objectShape(unwrap(inputSchema))
  if (!shape) return fields

  for (const [name, value] of Object.entries(shape)) {
    const optional = isOptional(value)
    const defaulted = hasDefault(value)
    fields.push({
      name,
      type: fieldTypeFromZod(value),
      isRequired: !optional && !defaulted,
      isId: false,
      hasDefault: defaulted,
    })
  }
  return fields
}

/**
 * Build the SDK's discover-time schema from registered factories.
 *
 * `edges` and `relations` are emitted as empty arrays. They were
 * populated from FK introspection in the old design; here the create
 * payload's `_alias` / `_ref` graph carries equivalent information at
 * request time, so the static schema doesn't need them.
 */
export function buildSchemaFromFactories(
  factories: FactoryRegistry,
  scopeField: string,
): SchemaInfo {
  const models: ModelInfo[] = []
  for (const [entity, factory] of Object.entries(factories)) {
    if (!factory.inputSchema) {
      throw new Error(
        `Factory "${entity}" has no inputSchema. Every factory must declare a Zod schema in defineFactory({ ..., inputSchema }).`,
      )
    }
    models.push({
      name: entity,
      tableName: camelToSnake(entity),
      fields: modelToFields(factory.inputSchema),
    })
  }

  return { models, edges: [], relations: [], scopeField }
}

/**
 * Serialise a `SchemaInfo` to the JSON shape the dashboard expects.
 *
 * Field names in the wire JSON are camelCase (`isRequired`, not
 * `is_required`); kept here so both halves of the discover response
 * live in one place.
 */
export function schemaToWire(schema: SchemaInfo): Record<string, unknown> {
  return {
    models: schema.models.map((m) => ({
      name: m.name,
      tableName: m.tableName,
      fields: m.fields.map((f) => ({
        name: f.name,
        type: f.type,
        isRequired: f.isRequired,
        isId: f.isId,
        hasDefault: f.hasDefault,
      })),
    })),
    edges: schema.edges.map((e) => ({
      from: e.from,
      to: e.to,
      localField: e.localField,
      foreignField: e.foreignField,
      nullable: e.nullable,
    })),
    relations: schema.relations.map((r) => ({
      parentModel: r.parentModel,
      childModel: r.childModel,
      parentField: r.parentField,
      childField: r.childField,
    })),
    scopeField: schema.scopeField,
  }
}
