import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@autonoma-ai/sdk/graph': resolve(__dirname, 'packages/sdk/src/graph.ts'),
      '@autonoma-ai/sdk': resolve(__dirname, 'packages/sdk/src/index.ts'),
    },
  },
  test: {
    include: ['**/integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
})
