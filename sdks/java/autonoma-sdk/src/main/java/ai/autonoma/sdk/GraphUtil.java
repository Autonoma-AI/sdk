package ai.autonoma.sdk;

import ai.autonoma.sdk.types.FKEdge;
import ai.autonoma.sdk.types.TopoSortResult;

import java.util.*;

/**
 * Kahn's topological sort + Tarjan's SCC for FK ordering and cycle detection.
 */
public final class GraphUtil {

    private GraphUtil() {}

    /**
     * Topological sort via Kahn's algorithm.
     * Returns sorted nodes and any strongly connected components (cycles).
     */
    public static TopoSortResult topoSort(List<String> nodes, List<FKEdge> edges) {
        Map<String, Integer> inDegree = new HashMap<>();
        Map<String, List<String>> adj = new HashMap<>();

        for (String node : nodes) {
            inDegree.put(node, 0);
            adj.put(node, new ArrayList<>());
        }

        Set<String> nodeSet = new HashSet<>(nodes);
        List<FKEdge> relevantEdges = edges.stream()
            .filter(e -> !e.from().equals(e.to()) && nodeSet.contains(e.from()) && nodeSet.contains(e.to()))
            .toList();

        for (FKEdge edge : relevantEdges) {
            adj.get(edge.to()).add(edge.from());
            inDegree.merge(edge.from(), 1, Integer::sum);
        }

        // First pass: standard Kahn's
        List<String> queue = new ArrayList<>();
        for (var entry : inDegree.entrySet()) {
            if (entry.getValue() == 0) queue.add(entry.getKey());
        }

        List<String> sorted = new ArrayList<>();
        while (!queue.isEmpty()) {
            Collections.sort(queue);
            String node = queue.remove(0);
            sorted.add(node);
            for (String neighbor : adj.getOrDefault(node, List.of())) {
                int newDeg = inDegree.getOrDefault(neighbor, 1) - 1;
                inDegree.put(neighbor, newDeg);
                if (newDeg == 0) queue.add(neighbor);
            }
        }

        // Find cycle nodes and their SCCs
        Set<String> sortedSet = new HashSet<>(sorted);
        List<String> unsortedNodes = nodes.stream().filter(n -> !sortedSet.contains(n)).toList();
        List<List<String>> cycles = unsortedNodes.isEmpty() ? List.of() : findSCCs(unsortedNodes, relevantEdges);

        if (cycles.isEmpty()) return new TopoSortResult(sorted, cycles);

        // Second pass: treat cycle nodes as "resolved" and re-run Kahn's
        Set<String> cycleNodeSet = new HashSet<>();
        for (List<String> cycle : cycles) cycleNodeSet.addAll(cycle);
        List<String> stillUnsorted = unsortedNodes.stream().filter(n -> !cycleNodeSet.contains(n)).toList();

        if (!stillUnsorted.isEmpty()) {
            Map<String, Integer> inDeg2 = new HashMap<>();
            Map<String, List<String>> adj2 = new HashMap<>();
            for (String node : stillUnsorted) {
                inDeg2.put(node, 0);
                adj2.put(node, new ArrayList<>());
            }
            Set<String> stillSet = new HashSet<>(stillUnsorted);
            for (FKEdge edge : relevantEdges) {
                if (stillSet.contains(edge.from()) && stillSet.contains(edge.to())) {
                    adj2.get(edge.to()).add(edge.from());
                    inDeg2.merge(edge.from(), 1, Integer::sum);
                }
            }
            List<String> queue2 = new ArrayList<>();
            for (var entry : inDeg2.entrySet()) {
                if (entry.getValue() == 0) queue2.add(entry.getKey());
            }
            while (!queue2.isEmpty()) {
                Collections.sort(queue2);
                String node = queue2.remove(0);
                sorted.add(node);
                for (String neighbor : adj2.getOrDefault(node, List.of())) {
                    int newDeg = inDeg2.getOrDefault(neighbor, 1) - 1;
                    inDeg2.put(neighbor, newDeg);
                    if (newDeg == 0) queue2.add(neighbor);
                }
            }
        }

        return new TopoSortResult(sorted, cycles);
    }

    /**
     * Find a nullable FK edge in a cycle that can be deferred. Skips self-referential edges.
     */
    public static FKEdge findDeferrableEdge(List<String> cycle, List<FKEdge> edges) {
        Set<String> cycleSet = new HashSet<>(cycle);
        for (FKEdge edge : edges) {
            if (cycleSet.contains(edge.from()) && cycleSet.contains(edge.to())
                && !edge.from().equals(edge.to()) && edge.nullable()) {
                return edge;
            }
        }
        return null;
    }

    /**
     * Tarjan's SCC algorithm to identify exact cycles among remaining nodes.
     */
    private static List<List<String>> findSCCs(List<String> nodes, List<FKEdge> edges) {
        Map<String, List<String>> adj = new HashMap<>();
        Set<String> nodeSet = new HashSet<>(nodes);
        for (String node : nodes) adj.put(node, new ArrayList<>());
        for (FKEdge edge : edges) {
            if (nodeSet.contains(edge.from()) && nodeSet.contains(edge.to())) {
                adj.get(edge.to()).add(edge.from());
            }
        }

        int[] indexCounter = {0};
        Deque<String> stack = new ArrayDeque<>();
        Set<String> onStack = new HashSet<>();
        Map<String, Integer> indices = new HashMap<>();
        Map<String, Integer> lowlinks = new HashMap<>();
        List<List<String>> sccs = new ArrayList<>();

        for (String node : nodes) {
            if (!indices.containsKey(node)) {
                strongConnect(node, adj, indexCounter, stack, onStack, indices, lowlinks, sccs);
            }
        }

        return sccs;
    }

    private static void strongConnect(
            String v,
            Map<String, List<String>> adj,
            int[] indexCounter,
            Deque<String> stack,
            Set<String> onStack,
            Map<String, Integer> indices,
            Map<String, Integer> lowlinks,
            List<List<String>> sccs) {

        indices.put(v, indexCounter[0]);
        lowlinks.put(v, indexCounter[0]);
        indexCounter[0]++;
        stack.push(v);
        onStack.add(v);

        for (String w : adj.getOrDefault(v, List.of())) {
            if (!indices.containsKey(w)) {
                strongConnect(w, adj, indexCounter, stack, onStack, indices, lowlinks, sccs);
                lowlinks.put(v, Math.min(lowlinks.get(v), lowlinks.get(w)));
            } else if (onStack.contains(w)) {
                lowlinks.put(v, Math.min(lowlinks.get(v), indices.get(w)));
            }
        }

        if (lowlinks.get(v).equals(indices.get(v))) {
            List<String> scc = new ArrayList<>();
            String w;
            do {
                w = stack.pop();
                onStack.remove(w);
                scc.add(w);
            } while (!w.equals(v));
            if (scc.size() > 1) sccs.add(scc);
        }
    }
}
