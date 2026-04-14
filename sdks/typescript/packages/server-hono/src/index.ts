import { handleRequest } from '@autonoma-ai/sdk'
import type { HandlerConfig, HandlerRequest } from '@autonoma-ai/sdk'

interface HonoContext {
  req: {
    raw: Request
  }
}

/**
 * Create a Hono-compatible handler.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import { createHonoHandler } from '@autonoma-ai/server-hono'
 *
 * const app = new Hono()
 * app.post('/api/autonoma', createHonoHandler(config))
 * ```
 */
export function createHonoHandler(config: HandlerConfig) {
  const enrichedConfig = { ...config, sdk: { ...config.sdk, server: 'hono' } }
  return async (c: HonoContext): Promise<Response> => {
    const body = await c.req.raw.text()
    const headers: Record<string, string> = {}
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })

    const handlerReq: HandlerRequest = { body, headers }
    const res = await handleRequest(enrichedConfig, handlerReq)

    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
