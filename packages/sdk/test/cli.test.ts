import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const CLI = join(__dirname, '../dist/cli.js')

describe('CLI: schema convert', () => {
  it('converts DMMF to autonoma schema', async () => {
    const dmmf = join(__dirname, '../../../fixtures/dmmf.json')
    const { stdout } = await exec('node', [CLI, 'schema', 'convert', dmmf, '--scope-field', 'testRunId'])
    const schema = JSON.parse(stdout)

    expect(schema.scopeField).toBe('testRunId')
    expect(schema.models).toHaveLength(4)
    expect(schema.edges).toHaveLength(2)
    expect(schema.models.map((m: any) => m.name).sort()).toEqual([
      'Category', 'Organization', 'Product', 'User',
    ])
  })

  it('writes to file with -o flag', async () => {
    const dmmf = join(__dirname, '../../../fixtures/dmmf.json')
    const outPath = join(__dirname, '../../../fixtures/_test-schema-out.json')

    try {
      await exec('node', [CLI, 'schema', 'convert', dmmf, '--scope-field', 'testRunId', '-o', outPath])
      const { readFile } = await import('node:fs/promises')
      const content = await readFile(outPath, 'utf-8')
      const schema = JSON.parse(content)
      expect(schema.scopeField).toBe('testRunId')
      expect(schema.models.length).toBeGreaterThan(0)
    } finally {
      await rm(outPath, { force: true })
    }
  })
})
