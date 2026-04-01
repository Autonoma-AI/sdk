const TEMPLATE_RE = /\{\{(.+?)\}\}/g

export interface TemplateContext {
  testRunId: string
  index: number
}

/**
 * Resolve all {{...}} expressions in a value. Handles strings, objects, and arrays recursively.
 */
export function resolveTemplate(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === 'string') return resolveString(value, ctx)
  if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, ctx))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveTemplate(v, ctx)
    }
    return result
  }
  return value
}

function resolveString(str: string, ctx: TemplateContext): unknown {
  // If the entire string is a single expression, return the raw value (preserving type)
  const fullMatch = str.match(/^\{\{(.+?)\}\}$/)
  if (fullMatch) {
    return evaluateExpression(fullMatch[1]!, ctx)
  }

  // Otherwise, interpolate expressions into the string
  return str.replace(TEMPLATE_RE, (_, expr: string) => {
    const val = evaluateExpression(expr, ctx)
    return String(val)
  })
}

function evaluateExpression(expr: string, ctx: TemplateContext): unknown {
  expr = expr.trim()

  // Simple variables
  if (expr === 'testRunId') return ctx.testRunId
  if (expr === 'index') return ctx.index
  if (expr === 'index1') return ctx.index + 1

  // cycle([...])
  const cycleMatch = expr.match(/^cycle\(\[(.+)\]\)$/)
  if (cycleMatch) {
    const items = parseArrayLiteral(cycleMatch[1]!)
    return items[ctx.index % items.length]
  }

  // pick([...])
  const pickMatch = expr.match(/^pick\(\[(.+)\]\)$/)
  if (pickMatch) {
    const items = parseArrayLiteral(pickMatch[1]!)
    return items[Math.floor(Math.random() * items.length)]
  }

  // random.int(a,b)
  const randIntMatch = expr.match(/^random\.int\((\d+),\s*(\d+)\)$/)
  if (randIntMatch) {
    const min = parseInt(randIntMatch[1]!, 10)
    const max = parseInt(randIntMatch[2]!, 10)
    return Math.floor(Math.random() * (max - min + 1)) + min
  }

  // random.float(a,b)
  const randFloatMatch = expr.match(/^random\.float\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\)$/)
  if (randFloatMatch) {
    const min = parseFloat(randFloatMatch[1]!)
    const max = parseFloat(randFloatMatch[2]!)
    return Math.random() * (max - min) + min
  }

  // now()
  if (expr === 'now()') return new Date().toISOString()

  // daysAgo(n)
  const daysAgoMatch = expr.match(/^daysAgo\((\d+)\)$/)
  if (daysAgoMatch) {
    const d = new Date()
    d.setDate(d.getDate() - parseInt(daysAgoMatch[1]!, 10))
    return d.toISOString()
  }

  throw new Error(`Template error: unknown expression '${expr}'`)
}

function parseArrayLiteral(raw: string): string[] {
  return raw.split(',').map((s) => {
    s = s.trim()
    // Strip surrounding quotes
    if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
      return s.slice(1, -1)
    }
    return s
  })
}
