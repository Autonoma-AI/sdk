import { readFileSync } from 'node:fs'
import { topoSort, findDeferrableEdge } from '../../sdks/typescript/packages/sdk/src/graph'
import { resolveTemplate } from '../../sdks/typescript/packages/sdk/src/template'
import { signBody, verifySignature } from '../../sdks/typescript/packages/sdk/src/hmac'
import { signRefs, verifyRefs } from '../../sdks/typescript/packages/sdk/src/refs'
import { fingerprint } from '../../sdks/typescript/packages/sdk/src/fingerprint'

const input = JSON.parse(readFileSync(0, 'utf-8'))

async function main() {
  try {
    let result: unknown

    switch (`${input.module}.${input.function}`) {
      case 'graph.topoSort':
        result = topoSort(input.input.nodes, input.input.edges)
        break
      case 'graph.findDeferrableEdge':
        result = findDeferrableEdge(input.input.cycle, input.input.edges)
        break
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
      case 'fingerprint.fingerprint':
        result = fingerprint(input.input.value)
        break
      case 'template.resolveTemplate':
        result = resolveTemplate(input.input.value, input.input.ctx)
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
