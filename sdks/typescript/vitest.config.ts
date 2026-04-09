import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const protocolVersion = readFileSync(
  resolve(__dirname, '../../protocol/version.txt'),
  'utf-8',
).trim()

export default defineConfig({
  resolve: {
    alias: {
      '@autonoma-ai/sdk/graph': resolve(__dirname, 'packages/sdk/src/graph.ts'),
      '@autonoma-ai/sdk': resolve(__dirname, 'packages/sdk/src/index.ts'),
    },
  },
  define: {
    __PROTOCOL_VERSION__: JSON.stringify(protocolVersion),
  },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/integration.test.*',
    ],
  },
})
