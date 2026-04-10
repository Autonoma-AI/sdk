import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const protocolVersion = readFileSync(
  resolve(__dirname, '../../../../protocol/version.txt'),
  'utf-8',
).trim()

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/graph.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  define: {
    __PROTOCOL_VERSION__: JSON.stringify(protocolVersion),
  },
})
