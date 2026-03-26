import { createHash } from 'node:crypto'

/**
 * Compute a stable 16-char hex fingerprint of a scenario definition.
 * Uses sha256 of the JSON-serialized spec with sorted keys.
 */
export function fingerprint(value: unknown): string {
  const json = JSON.stringify(value, sortReplacer)
  return createHash('sha256').update(json).digest('hex').slice(0, 16)
}

/**
 * JSON replacer that sorts object keys for deterministic serialization.
 */
function sortReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce(
        (sorted, k) => {
          sorted[k] = (value as Record<string, unknown>)[k]
          return sorted
        },
        {} as Record<string, unknown>,
      )
  }
  return value
}
