/**
 * Deterministic uniqueness helpers seeded from `testRunId`.
 *
 * When a scenario's `up` provisions records with unique columns, seed those
 * values from `testRunId` so they are unique per run yet reproducible: the
 * same inputs always produce the same output within a run, so a scenario's
 * `up` and a later `down` compute identical values without storing them.
 * The digest is `sha256(testRunId + " " + parts...)`, sliced to 12 hex chars,
 * and is byte-for-byte identical across every language SDK.
 */
import { createHash } from 'node:crypto'

const TOKEN_LENGTH = 12

function digest(testRunId: string, parts: ReadonlyArray<string | number>): string {
  const hash = createHash('sha256')
  hash.update(testRunId)
  for (const part of parts) {
    hash.update(' ')
    hash.update(String(part))
  }
  return hash.digest('hex')
}

/** A short hex token, deterministic per `(testRunId, ...parts)`. */
export function uniqueToken(
  testRunId: string,
  ...parts: Array<string | number>
): string {
  return digest(testRunId, parts).slice(0, TOKEN_LENGTH)
}

/** A unique id like `user_1a2b3c4d5e6f`, deterministic per inputs. */
export function uniqueId(
  testRunId: string,
  prefix = 'id',
  ...parts: Array<string | number>
): string {
  return `${prefix}_${uniqueToken(testRunId, prefix, ...parts)}`
}

/** A URL-safe slug like `acme-1a2b3c4d5e6f`, deterministic per inputs. */
export function uniqueSlug(
  testRunId: string,
  base = 'item',
  ...parts: Array<string | number>
): string {
  const normalized =
    String(base)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  return `${normalized}-${uniqueToken(testRunId, base, ...parts)}`
}

/** A unique email like `user+1a2b3c4d5e6f@example.com`, deterministic per inputs. */
export function uniqueEmail(
  testRunId: string,
  options?: { local?: string; domain?: string },
): string {
  const local = options?.local ?? 'user'
  const domain = options?.domain ?? 'example.com'
  return `${local}+${uniqueToken(testRunId, local, domain)}@${domain}`
}
