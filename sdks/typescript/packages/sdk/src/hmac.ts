import { createHmac, timingSafeEqual } from 'node:crypto'

export function signBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

export function verifySignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const expected = signBody(body, secret)
  if (expected.length !== signature.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}
