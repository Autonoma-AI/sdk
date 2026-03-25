import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@autonoma-ai/sdk/graph': resolve(__dirname, 'packages/sdk/src/graph.ts'),
      '@autonoma-ai/sdk': resolve(__dirname, 'packages/sdk/src/index.ts'),
    },
  },
})
