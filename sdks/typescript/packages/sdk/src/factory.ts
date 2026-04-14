import type { FactoryDefinition } from './types'

/**
 * Define a factory for creating entities via user code instead of raw SQL.
 * The factory's `create` function receives pre-resolved fields (temp IDs replaced with real IDs)
 * and must return at least the primary key field.
 */
export function defineFactory(definition: FactoryDefinition): FactoryDefinition {
  if (typeof definition.create !== 'function') {
    throw new Error('Factory definition must include a "create" function')
  }
  if (definition.teardown !== undefined && typeof definition.teardown !== 'function') {
    throw new Error('Factory "teardown" must be a function if provided')
  }
  return definition
}
