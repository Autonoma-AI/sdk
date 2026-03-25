#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SchemaInfo } from './types'

const HELP = `
autonoma — Autonoma SDK CLI

Commands:
  autonoma schema convert <dmmf.json>   Convert Prisma DMMF to autonoma schema

Options:
  --scope-field <name>   Scope field name (default: "testRunId")
  --pretty               Pretty-print output
  -o, --output <path>    Write output to file instead of stdout
  -h, --help             Show this help
`.trim()

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(HELP)
    process.exit(0)
  }

  const command = args[0]

  switch (command) {
    case 'schema':
      return await cmdSchema(args.slice(1))
    default:
      console.error(`Unknown command: ${command}`)
      console.log(HELP)
      process.exit(1)
  }
}

// ── schema convert ────────────────────────────────────────────────────────

async function cmdSchema(args: string[]) {
  const subcommand = args[0]

  if (subcommand !== 'convert') {
    console.error('Usage: autonoma schema convert <dmmf.json> --scope-field <name>')
    process.exit(1)
  }

  const flags = parseFlags(args.slice(1))
  const positional = flags._positional

  if (positional.length < 1) {
    console.error('Usage: autonoma schema convert <dmmf.json> --scope-field <name>')
    process.exit(1)
  }

  const dmmfPath = resolve(positional[0]!)
  const scopeField = (flags['--scope-field'] as string) ?? 'testRunId'
  const dmmf = await readJSON<DMMFInput>(dmmfPath)

  const schema = convertDMMFToSchema(dmmf, scopeField)

  const json = JSON.stringify(schema, null, 2)

  if (flags['-o'] || flags['--output']) {
    const outPath = resolve((flags['-o'] ?? flags['--output']) as string)
    await writeFile(outPath, json + '\n')
    console.error(`Schema written to ${outPath}`)
    console.error(`  ${schema.models.length} models, ${schema.edges.length} FK edges, scopeField: "${scopeField}"`)
  } else {
    console.log(json)
  }
}

// ── DMMF conversion ───────────────────────────────────────────────────────

interface DMMFInput {
  models: Record<string, DMMFModel> | DMMFModel[]
  datamodel?: { models: DMMFModel[] }
}

interface DMMFModel {
  name: string
  fields: DMMFField[]
}

interface DMMFField {
  name: string
  type: string
  kind: string
  isRequired: boolean
  isId: boolean
  hasDefaultValue: boolean
  relationFromFields?: string[]
  relationToFields?: string[]
}

function convertDMMFToSchema(dmmf: DMMFInput, scopeField: string): SchemaInfo {
  let dmmfModels: DMMFModel[]

  if (dmmf.datamodel?.models) {
    dmmfModels = dmmf.datamodel.models
  } else if (Array.isArray(dmmf.models)) {
    dmmfModels = dmmf.models
  } else {
    dmmfModels = Object.entries(dmmf.models).map(
      ([name, model]) => ({ ...model, name }),
    )
  }

  const models: SchemaInfo['models'] = []
  const edges: SchemaInfo['edges'] = []

  for (const model of dmmfModels) {
    const fields: SchemaInfo['models'][number]['fields'] = []

    for (const field of model.fields) {
      if (field.kind === 'object') {
        if (field.relationFromFields?.length) {
          edges.push({
            from: model.name,
            to: field.type,
            localField: field.relationFromFields[0]!,
            foreignField: field.relationToFields?.[0] ?? 'id',
            nullable: !field.isRequired,
          })
        }
        continue
      }

      if (field.kind === 'scalar' || field.kind === 'enum') {
        fields.push({
          name: field.name,
          type: field.type,
          isRequired: field.isRequired,
          isId: field.isId,
          hasDefault: field.hasDefaultValue,
        })
      }
    }

    models.push({ name: model.name, fields })
  }

  return { models, edges, relations: [], scopeField }
}

// ── Utilities ─────────────────────────────────────────────────────────────

async function readJSON<T>(path: string): Promise<T> {
  try {
    const content = await readFile(path, 'utf-8')
    return JSON.parse(content) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`File not found: ${path}`)
    } else if (err instanceof SyntaxError) {
      console.error(`Invalid JSON in ${path}: ${err.message}`)
    } else {
      console.error(`Error reading ${path}: ${err}`)
    }
    process.exit(1)
  }
}

interface ParsedFlags {
  [key: string]: string | boolean | string[]
  _positional: string[]
}

function parseFlags(args: string[]): ParsedFlags {
  const result: ParsedFlags = { _positional: [] }
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg.startsWith('-')) {
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        result[arg] = next
        i += 2
      } else {
        result[arg] = true
        i++
      }
    } else {
      result._positional.push(arg)
      i++
    }
  }
  return result
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
