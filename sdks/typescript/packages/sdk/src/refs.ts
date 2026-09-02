import { createHmac, timingSafeEqual } from 'node:crypto'

export interface RefsPayload {
  /** Whatever the scenario's `up` returned as `refs`; handed back to `down`. */
  refs: Record<string, unknown>
  testRunId: string
  /**
   * The scenario name. Named `environment` for wire/back-compat reasons
   * (v1 always signed `""` here); `down` reads it to route to the right
   * scenario's teardown.
   */
  environment: string
}

/**
 * Sign refs into a JWT-like token (header.payload.signature).
 * Uses HMAC-SHA256 — not a full JWT library to avoid dependencies.
 */
export function signRefs(payload: RefsPayload, secret: string): string {
  const header = base64url({ alg: 'HS256', typ: 'REFS' })
  const body = base64url(payload)
  const signature = hmac(`${header}.${body}`, secret)
  return `${header}.${body}.${signature}`
}

/**
 * Verify and decode a teardown token. Returns the payload or throws.
 */
export function verifyRefs(
  token: string,
  secret: string,
): RefsPayload {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('malformed token')

  const [header, body, signature] = parts
  const expected = hmac(`${header}.${body}`, secret)

  const expectedBuf = Buffer.from(expected)
  const signatureBuf = Buffer.from(signature!)
  if (expectedBuf.length !== signatureBuf.length || !timingSafeEqual(expectedBuf, signatureBuf)) {
    throw new Error('signature mismatch')
  }

  return JSON.parse(Buffer.from(body!, 'base64url').toString())
}

function base64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  )).toString('base64url')
}

function hmac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url')
}
