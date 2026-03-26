"""Topological sorting via Kahn's algorithm and cycle detection via Tarjan's SCC."""

from __future__ import annotations

from collections import defaultdict
from typing import Optional


def topo_sort(nodes: list[str], edges: list[dict]) -> dict:
    """
    Topological sort of nodes by FK dependency edges.
    Returns {"sorted": [...], "cycles": [[...]]}.
    """
    # Filter to only edges between known nodes, skip self-referential
    node_set = set(nodes)
    relevant_edges = [
        e for e in edges
        if e["from"] != e["to"] and e["from"] in node_set and e["to"] in node_set
    ]

    # Build in-degree map and adjacency list
    in_degree = {n: 0 for n in nodes}
    adj = defaultdict(list)

    for e in relevant_edges:
        # e["from"] depends on e["to"] (from has the FK pointing to to)
        adj[e["to"]].append(e["from"])
        in_degree[e["from"]] = in_degree.get(e["from"], 0) + 1

    # First pass: standard Kahn's
    queue = sorted([n for n, d in in_degree.items() if d == 0])
    sorted_nodes = []

    while queue:
        node = queue.pop(0)
        sorted_nodes.append(node)
        for neighbor in adj.get(node, []):
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)
        queue.sort()

    # Find unsorted nodes
    unsorted = [n for n in nodes if n not in sorted_nodes]

    if not unsorted:
        return {"sorted": sorted_nodes, "cycles": []}

    cycles = _find_sccs(unsorted, relevant_edges)

    if not cycles:
        return {"sorted": sorted_nodes, "cycles": []}

    # Second pass: treat cycle nodes as resolved and re-sort remaining
    cycle_nodes = set()
    for c in cycles:
        cycle_nodes.update(c)

    still_unsorted = [n for n in unsorted if n not in cycle_nodes]

    if still_unsorted:
        in_deg2 = {n: 0 for n in still_unsorted}
        adj2 = defaultdict(list)
        still_set = set(still_unsorted)

        for e in relevant_edges:
            if e["from"] in still_set and e["to"] in still_set:
                adj2[e["to"]].append(e["from"])
                in_deg2[e["from"]] = in_deg2.get(e["from"], 0) + 1

        queue2 = sorted([n for n, d in in_deg2.items() if d == 0])
        while queue2:
            node = queue2.pop(0)
            sorted_nodes.append(node)
            for neighbor in adj2.get(node, []):
                in_deg2[neighbor] -= 1
                if in_deg2[neighbor] == 0:
                    queue2.append(neighbor)
            queue2.sort()

    return {"sorted": sorted_nodes, "cycles": cycles}


def _find_sccs(nodes: list[str], edges: list[dict]) -> list[list[str]]:
    """Tarjan's SCC algorithm to identify exact cycles among remaining nodes."""
    node_set = set(nodes)
    adj = defaultdict(list)

    for e in edges:
        if e["from"] in node_set and e["to"] in node_set:
            adj[e["to"]].append(e["from"])

    index_counter = [0]
    stack = []
    on_stack = set()
    indices = {}
    lowlinks = {}
    sccs = []

    def strong_connect(v):
        indices[v] = index_counter[0]
        lowlinks[v] = index_counter[0]
        index_counter[0] += 1
        stack.append(v)
        on_stack.add(v)

        for w in adj.get(v, []):
            if w not in indices:
                strong_connect(w)
                lowlinks[v] = min(lowlinks[v], lowlinks[w])
            elif w in on_stack:
                lowlinks[v] = min(lowlinks[v], indices[w])

        if lowlinks[v] == indices[v]:
            scc = []
            while True:
                w = stack.pop()
                on_stack.discard(w)
                scc.append(w)
                if w == v:
                    break
            if len(scc) > 1:
                sccs.append(scc)

    for node in nodes:
        if node not in indices:
            strong_connect(node)

    return sccs


def find_deferrable_edge(cycle: list[str], edges: list[dict]) -> Optional[dict]:
    """Find a nullable FK edge in a cycle that can be deferred."""
    cycle_set = set(cycle)
    for e in edges:
        if (
            e["from"] in cycle_set
            and e["to"] in cycle_set
            and e["from"] != e["to"]
            and e.get("nullable") is True
        ):
            return e
    return None
