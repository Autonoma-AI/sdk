import type {
  HandlerConfig,
  HandlerRequest,
  HandlerResponse,
  CreateContext,
  ResolvedEntitySpec,
} from './types'
import { verifySignature } from './hmac'
import { signRefs, verifyRefs } from './refs'
import { resolveTree } from './tree'
import { AutonomaError, Errors } from './errors'

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
        return handleDiscover(config)
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

function handleDiscover(config: HandlerConfig): HandlerResponse {
  const schema = config.adapter.getSchema()
  return { status: 200, body: { schema } }
}

async function handleUp(
  config: HandlerConfig,
  body: Record<string, unknown>,
): Promise<HandlerResponse> {
  const create = body.create as Record<string, Record<string, unknown>[]> | undefined
  if (!create) throw Errors.invalidBody('missing "create" in request body')

  const testRunId = (body.testRunId as string) ?? crypto.randomUUID()
  const schema = config.adapter.getSchema()

  const tree = resolveTree(create, schema, testRunId)
  const refs: Record<string, Record<string, unknown>[]> = {}
  const idMap = new Map<string, string>()

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
      return fields
    })

    const spec: Record<string, ResolvedEntitySpec> = {
      [model]: { count: resolvedFields.length, fields: resolvedFields, batch: op.batch },
    }

    const context: CreateContext = { testRunId, refs }
    const created = await config.adapter.createEntities(spec, context)
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

    if (!config.adapter.updateEntity) {
      throw new Error(
        `Circular FK detected (${deferred.model}.${deferred.field}), but the ORM adapter does not implement updateEntity. ` +
        `Upgrade @autonoma-ai/sdk-prisma or @autonoma-ai/sdk-drizzle to a version that supports circular FK resolution.`,
      )
    }

    await config.adapter.updateEntity(deferred.model, realTargetId, { [deferred.field]: realRefId })
  }

  const scopeValue = detectScopeValue(refs, schema.scopeField) ?? testRunId

  const firstUser = findFirstUser(refs)
  let auth = { token: '' }
  if (config.auth && firstUser) {
    auth = await config.auth(firstUser)
  }

  const refsToken = signRefs(
    { refs, testRunId: scopeValue, environment: '' },
    config.signingSecret,
  )

  return { status: 200, body: { auth, refs, refsToken } }
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

  await config.adapter.teardown(payload.testRunId, payload.refs)

  return { status: 200, body: { ok: true } }
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
