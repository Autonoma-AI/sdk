import { describe, it, expect } from 'vitest'
import { topoSort, findDeferrableEdge } from '../src/graph.js'
import type { FKEdge } from '../src/types.js'

describe('topoSort', () => {
  it('sorts a linear dependency chain', () => {
    const nodes = ['order', 'user', 'product']
    const edges: FKEdge[] = [
      { from: 'order', to: 'user', localField: 'userId', foreignField: 'id', nullable: false },
      { from: 'order', to: 'product', localField: 'productId', foreignField: 'id', nullable: false },
    ]
    const { sorted, cycles } = topoSort(nodes, edges)
    expect(cycles).toEqual([])
    // user and product before order
    expect(sorted.indexOf('user')).toBeLessThan(sorted.indexOf('order'))
    expect(sorted.indexOf('product')).toBeLessThan(sorted.indexOf('order'))
  })

  it('handles nodes with no edges', () => {
    const { sorted, cycles } = topoSort(['a', 'b', 'c'], [])
    expect(sorted).toHaveLength(3)
    expect(cycles).toEqual([])
  })

  it('detects a simple cycle', () => {
    const nodes = ['a', 'b']
    const edges: FKEdge[] = [
      { from: 'a', to: 'b', localField: 'bId', foreignField: 'id', nullable: false },
      { from: 'b', to: 'a', localField: 'aId', foreignField: 'id', nullable: true },
    ]
    const { sorted, cycles } = topoSort(nodes, edges)
    expect(sorted).toEqual([])
    expect(cycles).toHaveLength(1)
    expect(cycles[0]).toContain('a')
    expect(cycles[0]).toContain('b')
  })

  it('handles mixed: some in cycle, some not', () => {
    const nodes = ['root', 'a', 'b']
    const edges: FKEdge[] = [
      { from: 'a', to: 'root', localField: 'rootId', foreignField: 'id', nullable: false },
      { from: 'a', to: 'b', localField: 'bId', foreignField: 'id', nullable: false },
      { from: 'b', to: 'a', localField: 'aId', foreignField: 'id', nullable: true },
    ]
    const { sorted, cycles } = topoSort(nodes, edges)
    expect(sorted).toContain('root')
    expect(cycles.flat()).toContain('a')
    expect(cycles.flat()).toContain('b')
  })

  it('ignores self-referential edges', () => {
    const nodes = ['category']
    const edges: FKEdge[] = [
      { from: 'category', to: 'category', localField: 'parentId', foreignField: 'id', nullable: true },
    ]
    const { sorted, cycles } = topoSort(nodes, edges)
    expect(sorted).toEqual(['category'])
    expect(cycles).toEqual([])
  })

  it('sorts non-cycle node that depends on a cycle', () => {
    const nodes = ['Root', 'A', 'B', 'C']
    const edges: FKEdge[] = [
      { from: 'A', to: 'B', localField: 'bId', foreignField: 'id', nullable: false },
      { from: 'B', to: 'A', localField: 'aId', foreignField: 'id', nullable: true },
      { from: 'C', to: 'A', localField: 'aId', foreignField: 'id', nullable: false },
      { from: 'C', to: 'Root', localField: 'rootId', foreignField: 'id', nullable: false },
    ]
    const { sorted, cycles } = topoSort(nodes, edges)
    expect(sorted).toContain('Root')
    expect(sorted).toContain('C')
    expect(sorted.indexOf('Root')).toBeLessThan(sorted.indexOf('C'))
    expect(cycles.flat()).toContain('A')
    expect(cycles.flat()).toContain('B')
  })

  it('handles two separate cycles with linking node', () => {
    const nodes = ['Root', 'A', 'B', 'C', 'D', 'Link']
    const edges: FKEdge[] = [
      { from: 'A', to: 'B', localField: 'bId', foreignField: 'id', nullable: false },
      { from: 'B', to: 'A', localField: 'aId', foreignField: 'id', nullable: true },
      { from: 'C', to: 'D', localField: 'dId', foreignField: 'id', nullable: false },
      { from: 'D', to: 'C', localField: 'cId', foreignField: 'id', nullable: true },
      { from: 'Link', to: 'A', localField: 'aId', foreignField: 'id', nullable: false },
      { from: 'Link', to: 'C', localField: 'cId', foreignField: 'id', nullable: false },
      { from: 'A', to: 'Root', localField: 'rootId', foreignField: 'id', nullable: false },
    ]
    const { sorted, cycles } = topoSort(nodes, edges)
    expect(sorted).toContain('Root')
    expect(sorted).toContain('Link')
    expect(sorted.indexOf('Root')).toBeLessThan(sorted.indexOf('Link'))
    expect(cycles).toHaveLength(2)
    expect(cycles.flat()).toContain('A')
    expect(cycles.flat()).toContain('B')
    expect(cycles.flat()).toContain('C')
    expect(cycles.flat()).toContain('D')
  })
})

describe('findDeferrableEdge', () => {
  it('finds a nullable edge in a cycle', () => {
    const cycle = ['a', 'b']
    const edges: FKEdge[] = [
      { from: 'a', to: 'b', localField: 'bId', foreignField: 'id', nullable: false },
      { from: 'b', to: 'a', localField: 'aId', foreignField: 'id', nullable: true },
    ]
    const edge = findDeferrableEdge(cycle, edges)
    expect(edge).not.toBeNull()
    expect(edge!.nullable).toBe(true)
    expect(edge!.from).toBe('b')
  })

  it('returns null if no nullable edge exists', () => {
    const cycle = ['a', 'b']
    const edges: FKEdge[] = [
      { from: 'a', to: 'b', localField: 'bId', foreignField: 'id', nullable: false },
      { from: 'b', to: 'a', localField: 'aId', foreignField: 'id', nullable: false },
    ]
    expect(findDeferrableEdge(cycle, edges)).toBeNull()
  })
})
