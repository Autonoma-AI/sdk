import { handleRequest } from '@autonoma/sdk'
import type { HandlerConfig, HandlerRequest } from '@autonoma/sdk'

/**
 * Create a Web standard handler (works with Next App Router, Hono, Bun, Deno).
 *
 * @example
 * ```ts
 * import { createHandler } from '@autonoma/server-web'
 * const handler = createHandler(config)
 * // Next.js App Router:
 * export const POST = handler
 * ```
 */
export function createHandler(config: HandlerConfig) {
  return async (req: Request): Promise<Response> => {
    const body = await req.text()
    const headers: Record<string, string> = {}
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })

    const handlerReq: HandlerRequest = { body, headers }
    const res = await handleRequest(config, handlerReq)

    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
