import { handleRequest } from '@autonoma-ai/sdk'
import type { HandlerConfig, HandlerRequest } from '@autonoma-ai/sdk'

interface ExpressRequest {
  body?: unknown
  headers: Record<string, string | string[] | undefined>
  on(event: string, listener: (...args: unknown[]) => void): void
}

interface ExpressResponse {
  status(code: number): ExpressResponse
  json(body: unknown): void
}

/**
 * Create an Express-compatible handler.
 *
 * @example
 * ```ts
 * import { createExpressHandler } from '@autonoma-ai/server-express'
 * app.post('/api/autonoma', createExpressHandler(config))
 * ```
 */
export function createExpressHandler(config: HandlerConfig) {
  return async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    const body = await readBody(req)
    const headers: Record<string, string> = {}
    for (const [key, val] of Object.entries(req.headers)) {
      if (typeof val === 'string') headers[key.toLowerCase()] = val
      else if (Array.isArray(val)) headers[key.toLowerCase()] = val[0] ?? ''
    }

    const handlerReq: HandlerRequest = { body, headers }
    const result = await handleRequest(config, handlerReq)
    res.status(result.status).json(result.body)
  }
}

function readBody(req: ExpressRequest): Promise<string> {
  if (req.body !== undefined && req.body !== null) {
    return Promise.resolve(
      typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
    )
  }

  return new Promise((resolve, reject) => {
    const chunks: unknown[] = []
    req.on('data', (...args: unknown[]) => chunks.push(args[0]))
    req.on('end', () => resolve(Buffer.concat(chunks as Uint8Array[]).toString()))
    req.on('error', (...args: unknown[]) => reject(args[0]))
  })
}
