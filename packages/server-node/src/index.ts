import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleRequest } from '@autonoma-ai/sdk'
import type { HandlerConfig, HandlerRequest } from '@autonoma-ai/sdk'

/**
 * Create a Node.js http handler.
 *
 * @example
 * ```ts
 * import { createNodeHandler } from '@autonoma-ai/server-node'
 * import http from 'node:http'
 * http.createServer(createNodeHandler(config)).listen(3000)
 * ```
 */
export function createNodeHandler(config: HandlerConfig) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req)
    const headers: Record<string, string> = {}
    for (const [key, val] of Object.entries(req.headers)) {
      if (typeof val === 'string') headers[key] = val
      else if (Array.isArray(val)) headers[key] = val[0] ?? ''
    }

    const handlerReq: HandlerRequest = { body, headers }
    const result = await handleRequest(config, handlerReq)

    res.writeHead(result.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result.body))
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}
