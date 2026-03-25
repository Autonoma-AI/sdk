import type { FKEdge } from './types'

export type { FKEdge }

export interface TopoSortResult {
  sorted: string[]
  cycles: string[][]
}

/**
 * Topological sort via Kahn's algorithm.
 * Returns sorted nodes and any strongly connected components (cycles).
 *
 * After detecting cycles, runs a second pass to sort nodes that depend on
 * cycle members (these aren't in cycles themselves but couldn't be sorted
 * while their cycle-member dependencies had non-zero in-degree).
 */
export function topoSort(nodes: string[], edges: FKEdge[]): TopoSortResult {
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()

  for (const node of nodes) {
    inDegree.set(node, 0)
    adj.set(node, [])
  }

  // Filter to only edges between known nodes, skip self-referential
  const relevantEdges = edges.filter(
    (e) => e.from !== e.to && nodes.includes(e.from) && nodes.includes(e.to),
  )

  for (const edge of relevantEdges) {
    // edge.from depends on edge.to (from has the FK pointing to to)
    adj.get(edge.to)!.push(edge.from)
    inDegree.set(edge.from, (inDegree.get(edge.from) ?? 0) + 1)
  }

  // First pass: standard Kahn's
  const queue: string[] = []
  for (const [node, deg] of inDegree) {
    if (deg === 0) queue.push(node)
  }

  const sorted: string[] = []
  while (queue.length > 0) {
    queue.sort()
    const node = queue.shift()!
    sorted.push(node)
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, newDeg)
      if (newDeg === 0) queue.push(neighbor)
    }
  }

  // Find cycle nodes and their SCCs
  const unsortedNodes = nodes.filter((n) => !sorted.includes(n))
  const cycles = unsortedNodes.length > 0 ? findSCCs(unsortedNodes, relevantEdges) : []

  if (cycles.length === 0) return { sorted, cycles }

  // Second pass: treat cycle nodes as "resolved" and re-run Kahn's
  // for any remaining unsorted nodes that depend on cycle members
  const cycleNodeSet = new Set(cycles.flat())
  const stillUnsorted = unsortedNodes.filter((n) => !cycleNodeSet.has(n))

  if (stillUnsorted.length > 0) {
    // Reset in-degrees for unsorted non-cycle nodes, counting only edges
    // from other unsorted non-cycle nodes (cycle deps are resolved)
    const inDeg2 = new Map<string, number>()
    const adj2 = new Map<string, string[]>()

    for (const node of stillUnsorted) {
      inDeg2.set(node, 0)
      adj2.set(node, [])
    }

    const stillSet = new Set(stillUnsorted)
    for (const edge of relevantEdges) {
      if (stillSet.has(edge.from) && stillSet.has(edge.to)) {
        adj2.get(edge.to)!.push(edge.from)
        inDeg2.set(edge.from, (inDeg2.get(edge.from) ?? 0) + 1)
      }
    }

    const queue2: string[] = []
    for (const [node, deg] of inDeg2) {
      if (deg === 0) queue2.push(node)
    }

    while (queue2.length > 0) {
      queue2.sort()
      const node = queue2.shift()!
      sorted.push(node)
      for (const neighbor of adj2.get(node) ?? []) {
        const newDeg = (inDeg2.get(neighbor) ?? 1) - 1
        inDeg2.set(neighbor, newDeg)
        if (newDeg === 0) queue2.push(neighbor)
      }
    }
  }

  return { sorted, cycles }
}

/**
 * Tarjan's SCC algorithm to identify exact cycles among remaining nodes.
 */
function findSCCs(nodes: string[], edges: FKEdge[]): string[][] {
  const adj = new Map<string, string[]>()
  const nodeSet = new Set(nodes)

  for (const node of nodes) adj.set(node, [])
  for (const edge of edges) {
    if (nodeSet.has(edge.from) && nodeSet.has(edge.to)) {
      adj.get(edge.to)!.push(edge.from)
    }
  }

  let index = 0
  const stack: string[] = []
  const onStack = new Set<string>()
  const indices = new Map<string, number>()
  const lowlinks = new Map<string, number>()
  const sccs: string[][] = []

  function strongConnect(v: string) {
    indices.set(v, index)
    lowlinks.set(v, index)
    index++
    stack.push(v)
    onStack.add(v)

    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w)
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!))
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!))
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        scc.push(w)
      } while (w !== v)
      if (scc.length > 1) sccs.push(scc)
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) strongConnect(node)
  }

  return sccs
}

/**
 * Find a nullable FK edge in a cycle that can be deferred.
 * Skips self-referential edges.
 */
export function findDeferrableEdge(
  cycle: string[],
  edges: FKEdge[],
): FKEdge | null {
  const cycleSet = new Set(cycle)
  for (const edge of edges) {
    if (cycleSet.has(edge.from) && cycleSet.has(edge.to) && edge.from !== edge.to && edge.nullable) {
      return edge
    }
  }
  return null
}
