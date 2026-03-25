import { createHmac } from 'node:crypto'

interface RefsPayload {
  refs: Record<string, Record<string, unknown>[]>
  testRunId: string
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
 * Verify and decode a refs token. Returns the payload or throws.
 */
export function verifyRefs(
  token: string,
  secret: string,
): RefsPayload {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('malformed token')

  const [header, body, signature] = parts
  const expected = hmac(`${header}.${body}`, secret)

  if (expected !== signature) throw new Error('signature mismatch')

  return JSON.parse(Buffer.from(body!, 'base64url').toString())
}

function base64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function hmac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url')
}
