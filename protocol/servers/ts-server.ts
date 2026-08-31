#!/usr/bin/env node
/**
 * Minimal Node HTTP server that runs the TypeScript SDK's v2 handler with a
 * couple of scenarios. Used by `run-suites.mjs` to exercise the shared
 * `protocol/suites/*` against a real TypeScript endpoint.
 */
import { createServer } from 'node:http'
import { handleRequest } from '../../sdks/typescript/packages/sdk/src/handler'
import { defineScenario } from '../../sdks/typescript/packages/sdk/src/scenario'
import type { HandlerConfig } from '../../sdks/typescript/packages/sdk/src/types'

const sharedSecret = process.env.AUTONOMA_SHARED_SECRET ?? 'protocol-shared'
const signingSecret = process.env.AUTONOMA_SIGNING_SECRET ?? 'protocol-signing'
const port = Number(process.env.PORT ?? 4599)

const config: HandlerConfig = {
  sharedSecret,
  signingSecret,
  sdk: { orm: 'none', server: 'node' },
  scenarios: [
    defineScenario({
      name: 'standard',
      description: 'A standard seeded environment',
      up: ({ testRunId }) => ({
        auth: { headers: { Authorization: `Bearer token-${testRunId}` } },
        teardown: { userId: `user-${testRunId}` },
      }),
      down: () => {},
    }),
    defineScenario({
      name: 'empty',
      description: 'Nothing seeded',
      up: () => ({}),
    }),
  ],
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString()
    const headers: Record<string, string> = {}
    for (const [key, val] of Object.entries(req.headers)) {
      if (typeof val === 'string') headers[key.toLowerCase()] = val
    }
    const result = await handleRequest(config, { body, headers })
    res.writeHead(result.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result.body))
  })
})

server.listen(port, () => {
  console.log(`ts-server listening on ${port}`)
})
