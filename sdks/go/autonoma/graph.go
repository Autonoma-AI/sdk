package autonoma

import "sort"

// TopoSortResult contains sorted nodes and any detected cycles.
type TopoSortResult struct {
	Sorted []string   `json:"sorted"`
	Cycles [][]string `json:"cycles"`
}

// TopoSort performs topological sort via Kahn's algorithm.
// Returns sorted nodes and any strongly connected components (cycles).
func TopoSort(nodes []string, edges []FKEdge) TopoSortResult {
	nodeSet := make(map[string]bool, len(nodes))
	for _, n := range nodes {
		nodeSet[n] = true
	}

	inDegree := make(map[string]int, len(nodes))
	adj := make(map[string][]string, len(nodes))
	for _, n := range nodes {
		inDegree[n] = 0
		adj[n] = nil
	}

	// Filter to only edges between known nodes, skip self-referential
	var relevantEdges []FKEdge
	for _, e := range edges {
		if e.From != e.To && nodeSet[e.From] && nodeSet[e.To] {
			relevantEdges = append(relevantEdges, e)
		}
	}

	for _, edge := range relevantEdges {
		// edge.From depends on edge.To (From has the FK pointing to To)
		adj[edge.To] = append(adj[edge.To], edge.From)
		inDegree[edge.From]++
	}

	// First pass: standard Kahn's
	var queue []string
	for _, n := range nodes {
		if inDegree[n] == 0 {
			queue = append(queue, n)
		}
	}

	var sorted []string
	for len(queue) > 0 {
		sort.Strings(queue)
		node := queue[0]
		queue = queue[1:]
		sorted = append(sorted, node)
		for _, neighbor := range adj[node] {
			inDegree[neighbor]--
			if inDegree[neighbor] == 0 {
				queue = append(queue, neighbor)
			}
		}
	}

	// Find unsorted nodes (cycle members + dependents)
	sortedSet := make(map[string]bool, len(sorted))
	for _, s := range sorted {
		sortedSet[s] = true
	}
	var unsortedNodes []string
	for _, n := range nodes {
		if !sortedSet[n] {
			unsortedNodes = append(unsortedNodes, n)
		}
	}

	cycles := findSCCs(unsortedNodes, relevantEdges)
	if len(cycles) == 0 {
		if sorted == nil {
			sorted = []string{}
		}
		return TopoSortResult{Sorted: sorted, Cycles: [][]string{}}
	}

	// Second pass: treat cycle nodes as "resolved" and re-run Kahn's
	cycleNodeSet := make(map[string]bool)
	for _, cycle := range cycles {
		for _, n := range cycle {
			cycleNodeSet[n] = true
		}
	}

	var stillUnsorted []string
	for _, n := range unsortedNodes {
		if !cycleNodeSet[n] {
			stillUnsorted = append(stillUnsorted, n)
		}
	}

	if len(stillUnsorted) > 0 {
		stillSet := make(map[string]bool, len(stillUnsorted))
		for _, n := range stillUnsorted {
			stillSet[n] = true
		}

		inDeg2 := make(map[string]int, len(stillUnsorted))
		adj2 := make(map[string][]string, len(stillUnsorted))
		for _, n := range stillUnsorted {
			inDeg2[n] = 0
			adj2[n] = nil
		}

		for _, edge := range relevantEdges {
			if stillSet[edge.From] && stillSet[edge.To] {
				adj2[edge.To] = append(adj2[edge.To], edge.From)
				inDeg2[edge.From]++
			}
		}

		var queue2 []string
		for _, n := range stillUnsorted {
			if inDeg2[n] == 0 {
				queue2 = append(queue2, n)
			}
		}

		for len(queue2) > 0 {
			sort.Strings(queue2)
			node := queue2[0]
			queue2 = queue2[1:]
			sorted = append(sorted, node)
			for _, neighbor := range adj2[node] {
				inDeg2[neighbor]--
				if inDeg2[neighbor] == 0 {
					queue2 = append(queue2, neighbor)
				}
			}
		}
	}

	if sorted == nil {
		sorted = []string{}
	}

	return TopoSortResult{Sorted: sorted, Cycles: cycles}
}

// findSCCs implements Tarjan's SCC algorithm.
func findSCCs(nodes []string, edges []FKEdge) [][]string {
	if len(nodes) == 0 {
		return nil
	}

	nodeSet := make(map[string]bool, len(nodes))
	for _, n := range nodes {
		nodeSet[n] = true
	}

	adj := make(map[string][]string, len(nodes))
	for _, n := range nodes {
		adj[n] = nil
	}
	for _, edge := range edges {
		if nodeSet[edge.From] && nodeSet[edge.To] {
			adj[edge.To] = append(adj[edge.To], edge.From)
		}
	}

	index := 0
	var stack []string
	onStack := make(map[string]bool)
	indices := make(map[string]int)
	lowlinks := make(map[string]int)
	var sccs [][]string

	var strongConnect func(v string)
	strongConnect = func(v string) {
		indices[v] = index
		lowlinks[v] = index
		index++
		stack = append(stack, v)
		onStack[v] = true

		for _, w := range adj[v] {
			if _, visited := indices[w]; !visited {
				strongConnect(w)
				if lowlinks[w] < lowlinks[v] {
					lowlinks[v] = lowlinks[w]
				}
			} else if onStack[w] {
				if indices[w] < lowlinks[v] {
					lowlinks[v] = indices[w]
				}
			}
		}

		if lowlinks[v] == indices[v] {
			var scc []string
			for {
				w := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				onStack[w] = false
				scc = append(scc, w)
				if w == v {
					break
				}
			}
			if len(scc) > 1 {
				sccs = append(sccs, scc)
			}
		}
	}

	for _, n := range nodes {
		if _, visited := indices[n]; !visited {
			strongConnect(n)
		}
	}

	return sccs
}

// FindDeferrableEdge finds a nullable FK edge in a cycle that can be deferred.
func FindDeferrableEdge(cycle []string, edges []FKEdge) *FKEdge {
	cycleSet := make(map[string]bool, len(cycle))
	for _, n := range cycle {
		cycleSet[n] = true
	}

	for _, edge := range edges {
		if cycleSet[edge.From] && cycleSet[edge.To] && edge.From != edge.To && edge.Nullable {
			e := edge // copy
			return &e
		}
	}
	return nil
}
