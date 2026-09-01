import { readFileSync } from 'node:fs'
import { signBody, verifySignature } from '../../sdks/typescript/packages/sdk/src/hmac'
import { signRefs, verifyRefs } from '../../sdks/typescript/packages/sdk/src/refs'
import { uniqueEmail, uniqueId, uniqueSlug, uniqueToken } from '../../sdks/typescript/packages/sdk/src/unique'

const input = JSON.parse(readFileSync(0, 'utf-8'))

async function main() {
  try {
    let result: unknown

    switch (`${input.module}.${input.function}`) {
      case 'hmac.signBody':
        result = await signBody(input.input.body, input.input.secret)
        break
      case 'hmac.verifySignature':
        result = await verifySignature(input.input.body, input.input.signature, input.input.secret)
        break
      case 'refs.signRefs':
        result = signRefs(input.input.payload, input.input.secret)
        break
      case 'refs.verifyRefs':
        result = verifyRefs(input.input.token, input.input.secret)
        break
      case 'unique.uniqueToken':
        result = uniqueToken(input.input.testRunId, ...input.input.parts)
        break
      case 'unique.uniqueId':
        result = uniqueId(input.input.testRunId, input.input.prefix, ...input.input.parts)
        break
      case 'unique.uniqueSlug':
        result = uniqueSlug(input.input.testRunId, input.input.base, ...input.input.parts)
        break
      case 'unique.uniqueEmail':
        result = uniqueEmail(input.input.testRunId, { local: input.input.local, domain: input.input.domain })
        break
      default:
        throw new Error(`Unknown function: ${input.module}.${input.function}`)
    }

    console.log(JSON.stringify({ ok: true, result }))
  } catch (err: any) {
    console.log(JSON.stringify({ ok: false, error: err.message }))
  }
}

main()
