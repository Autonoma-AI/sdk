import type {
  HandlerConfig,
  HandlerRequest,
  HandlerResponse,
  ResolvedEntitySpec,
  SdkInfo,
} from './types'
import { verifySignature } from './hmac'
import { signRefs, verifyRefs } from './refs'
import { resolveTree } from './tree'
import { AutonomaError, Errors } from './errors'
import { getDialect } from './dialect'
import { introspectDatabase, type IntrospectionResult } from './introspect'
import { createEntities, updateEntity } from './create'
import { teardown } from './teardown'

/** Cache introspection results per config to avoid re-querying on every request */
const introspectionCache = new WeakMap<HandlerConfig, IntrospectionResult>()

async function getIntrospection(config: HandlerConfig): Promise<IntrospectionResult> {
  let cached = introspectionCache.get(config)
  if (cached) return cached

  const dialect = getDialect(config.dialect)
  cached = await introspectDatabase(config.executor, dialect, {
    scopeField: config.scopeField,
    schema: config.dbSchema,
    tableNameMap: config.tableNameMap,
    excludeTables: config.excludeTables,
  })
  introspectionCache.set(config, cached)
  return cached
}

declare const __PROTOCOL_VERSION__: string
export const PROTOCOL_VERSION = __PROTOCOL_VERSION__

function buildSdkMeta(config: HandlerConfig): { version: string; sdk: SdkInfo } {
  return {
    version: PROTOCOL_VERSION,
    sdk: {
      language: 'typescript',
      orm: config.sdk?.orm ?? 'unknown',
      server: config.sdk?.server ?? 'unknown',
    },
  }
}

export async function handleRequest(
  config: HandlerConfig,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  try {
    if (config.sharedSecret === config.signingSecret) {
      throw new AutonomaError(
        'sharedSecret and signingSecret must be different. The shared secret is known by Autonoma; the signing secret must be private.',
        'SAME_SECRETS',
        500,
      )
    }

    if (!config.allowProduction && process.env.NODE_ENV === 'production') {
      throw Errors.productionBlocked()
    }

    const signature = req.headers['x-signature'] ?? req.headers['X-Signature'] ?? ''
    if (!verifySignature(req.body, signature, config.sharedSecret)) {
      throw Errors.invalidSignature()
    }

    let body: Record<string, unknown>
    try {
      body = JSON.parse(req.body)
    } catch {
      throw Errors.invalidBody('invalid JSON')
    }

    const action = body.action as string
    if (!action) throw Errors.invalidBody('missing action')

    switch (action) {
      case 'discover':
        return await handleDiscover(config)
      case 'up':
        return await handleUp(config, body)
      case 'down':
        return await handleDown(config, body)
      default:
        throw Errors.unknownAction(action)
    }
  } catch (err) {
    if (err instanceof AutonomaError) {
      return { status: err.status, body: { error: err.message, code: err.code } }
    }
    const message = err instanceof Error ? err.message : 'Internal error'
    return { status: 500, body: { error: message, code: 'INTERNAL_ERROR' } }
  }
}

async function handleDiscover(config: HandlerConfig): Promise<HandlerResponse> {
  const { schema } = await getIntrospection(config)
  return { status: 200, body: { ...buildSdkMeta(config), schema } }
}

async function handleUp(
  config: HandlerConfig,
  body: Record<string, unknown>,
): Promise<HandlerResponse> {
  const create = body.create as Record<string, Record<string, unknown>[]> | undefined
  if (!create) throw Errors.invalidBody('missing "create" in request body')

  const testRunId = (body.testRunId as string) ?? crypto.randomUUID()
  const { schema, tableMap, columnMaps, enumTypeMaps } = await getIntrospection(config)
  const dialect = getDialect(config.dialect)

  const tree = resolveTree(create, schema, testRunId)
  const refs: Record<string, Record<string, unknown>[]> = {}
  const idMap = new Map<string, string>()

  await config.executor.transaction(async (tx) => {
    let i = 0
    while (i < tree.ops.length) {
      const op = tree.ops[i]!
      const model = op.model

      // Collect consecutive ops for the same model with same batch flag
      const batch: typeof tree.ops = [op]
      while (i + 1 < tree.ops.length && tree.ops[i + 1]!.model === model && tree.ops[i + 1]!.batch === op.batch) {
        i++
        batch.push(tree.ops[i]!)
      }

      // Replace temp IDs with real IDs in all fields
      const modelInfo = schema.models.find((m) => m.name === model)
      const resolvedFields = batch.map((b) => {
        const fields = { ...b.fields }
        delete fields.id
        for (const [key, value] of Object.entries(fields)) {
          if (typeof value === 'string' && value.startsWith('__temp_')) {
            const realId = idMap.get(value)
            if (realId) fields[key] = realId
          }
        }
        // Inject scope field if applicable
        const scopeEdge = schema.edges.find(
          (e) => e.from === model && e.localField.toLowerCase() === schema.scopeField.toLowerCase() && e.from !== e.to,
        )
        if (scopeEdge && !(scopeEdge.localField in fields)) {
          const scopeVal = detectScopeValue(refs, schema.scopeField)
          if (scopeVal) fields[scopeEdge.localField] = scopeVal
        }
        // Auto-populate required fields without DB defaults (e.g. Prisma's @updatedAt)
        if (modelInfo) {
          for (const field of modelInfo.fields) {
            if (field.isRequired && !field.hasDefault && !field.isId && !(field.name in fields)) {
              if (field.type === 'DateTime') {
                fields[field.name] = new Date()
              }
            }
          }
        }
        return fields
      })

      const spec: Record<string, ResolvedEntitySpec> = {
        [model]: { count: resolvedFields.length, fields: resolvedFields, batch: op.batch },
      }

      const context = { testRunId, refs }
      const created = await createEntities(tx, dialect, tableMap, columnMaps, spec, context, enumTypeMaps)
      const records = created[model] ?? []

      if (!refs[model]) refs[model] = []
      refs[model].push(...records)

      for (let j = 0; j < batch.length; j++) {
        const record = records[j]
        if (record && typeof record.id === 'string') {
          idMap.set(batch[j]!.tempId, record.id)
        }
      }

      i++
    }

    // Resolve deferred FK updates (circular dependency cycles)
    for (const deferred of tree.deferredUpdates) {
      const realTargetId = idMap.get(deferred.targetTempId)
      const refTempId = tree.aliases.get(deferred.refAlias)
      const realRefId = refTempId ? idMap.get(refTempId) : undefined

      if (!realTargetId || !realRefId) {
        throw new Error(
          `_ref "${deferred.refAlias}" could not be resolved. Ensure the referenced node has _alias defined in the scenario.`,
        )
      }

      await updateEntity(tx, dialect, tableMap, columnMaps, deferred.model, realTargetId, { [deferred.field]: realRefId }, enumTypeMaps)
    }
  })

  const scopeValue = detectScopeValue(refs, schema.scopeField) ?? testRunId

  const firstUser = findFirstUser(refs)
  const auth = await config.auth(firstUser)

  const refsToken = signRefs(
    { refs, testRunId: scopeValue, environment: '' },
    config.signingSecret,
  )

  return { status: 200, body: { ...buildSdkMeta(config), auth, refs, refsToken } }
}

async function handleDown(
  config: HandlerConfig,
  body: Record<string, unknown>,
): Promise<HandlerResponse> {
  const refsToken = body.refsToken as string
  if (!refsToken) throw Errors.invalidBody('missing refsToken')

  let payload: ReturnType<typeof verifyRefs>
  try {
    payload = verifyRefs(refsToken, config.signingSecret)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid token'
    throw Errors.invalidRefsToken(message)
  }

  const { schema, tableMap, columnMaps } = await getIntrospection(config)
  const dialect = getDialect(config.dialect)

  await teardown(config.executor, dialect, tableMap, columnMaps, schema, payload.testRunId, payload.refs)

  return { status: 200, body: { ...buildSdkMeta(config), ok: true } }
}

function findFirstUser(
  refs: Record<string, Record<string, unknown>[]>,
): Record<string, unknown> | null {
  for (const [model, records] of Object.entries(refs)) {
    if (model.toLowerCase() === 'user' && records.length > 0) {
      return records[0]!
    }
  }
  return null
}

function detectScopeValue(
  refs: Record<string, Record<string, unknown>[]>,
  scopeField: string,
): string | null {
  const scopeLower = scopeField.toLowerCase()
  for (const records of Object.values(refs)) {
    for (const record of records) {
      for (const [key, value] of Object.entries(record)) {
        if (key.toLowerCase() === scopeLower && typeof value === 'string') {
          return value
        }
      }
    }
  }
  return null
}
