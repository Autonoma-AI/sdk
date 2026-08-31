import type { ZodTypeAny } from 'zod'
import type { FactoryDefinition } from './types'

/**
 * Define a factory for creating entities via user code. In v2 this is an
 * OPTIONAL helper a scenario's `up`/`down` may call internally - it is not
 * wired to the wire protocol, and `discover` no longer derives a schema from
 * it. The `inputSchema` (Zod) validates the input before `create` runs.
 *
 * The generics are inferred from the schemas you pass in: `create`'s
 * `data` argument is typed as `z.infer<typeof inputSchema>`, and
 * `teardown`'s `record` argument is typed as `z.infer<typeof refSchema>`
 * when one is set. No call-site `z.infer<...>` annotations needed.
 */
export function defineFactory<
  TInput extends ZodTypeAny,
  TRef extends ZodTypeAny | undefined = undefined,
>(
  definition: FactoryDefinition<TInput, TRef>,
): FactoryDefinition<TInput, TRef> {
  if (typeof definition.create !== 'function') {
    throw new Error('Factory definition must include a "create" function')
  }
  if (definition.teardown !== undefined && typeof definition.teardown !== 'function') {
    throw new Error('Factory "teardown" must be a function if provided')
  }
  if (!definition.inputSchema || !isZodSchema(definition.inputSchema)) {
    throw new Error(
      'Factory "inputSchema" must be a Zod schema (e.g. z.object({...})) ' +
        'so it can validate the input before create runs.',
    )
  }
  if (definition.refSchema !== undefined && !isZodSchema(definition.refSchema)) {
    throw new Error('Factory "refSchema" must be a Zod schema if provided')
  }
  return definition
}

function isZodSchema(value: unknown): value is ZodTypeAny {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { parse?: unknown; safeParse?: unknown }
  return typeof candidate.parse === 'function' && typeof candidate.safeParse === 'function'
}
