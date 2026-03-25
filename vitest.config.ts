import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@autonoma/sdk/graph': resolve(__dirname, 'packages/sdk/src/graph.ts'),
      '@autonoma/sdk': resolve(__dirname, 'packages/sdk/src/index.ts'),
    },
  },
})
