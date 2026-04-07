<?php
namespace Autonoma\Sdk;

class Graph
{
    /**
     * Topological sort of nodes by FK dependency edges.
     * Returns ['sorted' => [...], 'cycles' => [[...]]].
     */
    public static function topoSort(array $nodes, array $edges): array
    {
        $nodeSet = array_flip($nodes);
        // Filter to only edges between known nodes, skip self-referential
        $relevantEdges = array_filter($edges, fn($e) =>
            $e['from'] !== $e['to'] &&
            isset($nodeSet[$e['from']]) &&
            isset($nodeSet[$e['to']])
        );
        $relevantEdges = array_values($relevantEdges);

        // Build in-degree map and adjacency list
        $inDegree = array_fill_keys($nodes, 0);
        $adj = [];
        foreach ($relevantEdges as $e) {
            $adj[$e['to']][] = $e['from'];
            $inDegree[$e['from']] = ($inDegree[$e['from']] ?? 0) + 1;
        }

        // First pass: standard Kahn's
        $queue = [];
        foreach ($inDegree as $n => $d) {
            if ($d === 0) $queue[] = $n;
        }
        sort($queue);
        $sortedNodes = [];

        while (!empty($queue)) {
            $node = array_shift($queue);
            $sortedNodes[] = $node;
            foreach ($adj[$node] ?? [] as $neighbor) {
                $inDegree[$neighbor]--;
                if ($inDegree[$neighbor] === 0) {
                    $queue[] = $neighbor;
                }
            }
            sort($queue);
        }

        // Find unsorted nodes
        $sortedSet = array_flip($sortedNodes);
        $unsorted = array_filter($nodes, fn($n) => !isset($sortedSet[$n]));
        $unsorted = array_values($unsorted);

        if (empty($unsorted)) {
            return ['sorted' => $sortedNodes, 'cycles' => []];
        }

        $cycles = self::findSccs($unsorted, $relevantEdges);

        if (empty($cycles)) {
            return ['sorted' => $sortedNodes, 'cycles' => []];
        }

        // Second pass: treat cycle nodes as resolved and re-sort remaining
        $cycleNodes = [];
        foreach ($cycles as $c) {
            foreach ($c as $n) {
                $cycleNodes[$n] = true;
            }
        }

        $stillUnsorted = array_filter($unsorted, fn($n) => !isset($cycleNodes[$n]));
        $stillUnsorted = array_values($stillUnsorted);

        if (!empty($stillUnsorted)) {
            $stillSet = array_flip($stillUnsorted);
            $inDeg2 = array_fill_keys($stillUnsorted, 0);
            $adj2 = [];

            foreach ($relevantEdges as $e) {
                if (isset($stillSet[$e['from']]) && isset($stillSet[$e['to']])) {
                    $adj2[$e['to']][] = $e['from'];
                    $inDeg2[$e['from']] = ($inDeg2[$e['from']] ?? 0) + 1;
                }
            }

            $queue2 = [];
            foreach ($inDeg2 as $n => $d) {
                if ($d === 0) $queue2[] = $n;
            }
            sort($queue2);

            while (!empty($queue2)) {
                $node = array_shift($queue2);
                $sortedNodes[] = $node;
                foreach ($adj2[$node] ?? [] as $neighbor) {
                    $inDeg2[$neighbor]--;
                    if ($inDeg2[$neighbor] === 0) {
                        $queue2[] = $neighbor;
                    }
                }
                sort($queue2);
            }
        }

        return ['sorted' => $sortedNodes, 'cycles' => $cycles];
    }

    /** Tarjan's SCC algorithm to identify exact cycles. */
    private static function findSccs(array $nodes, array $edges): array
    {
        $nodeSet = array_flip($nodes);
        $adj = [];
        foreach ($edges as $e) {
            if (isset($nodeSet[$e['from']]) && isset($nodeSet[$e['to']])) {
                $adj[$e['to']][] = $e['from'];
            }
        }

        $indexCounter = 0;
        $stack = [];
        $onStack = [];
        $indices = [];
        $lowlinks = [];
        $sccs = [];

        $strongConnect = null;
        $strongConnect = function (string $v) use (&$indexCounter, &$stack, &$onStack, &$indices, &$lowlinks, &$sccs, &$adj, &$strongConnect) {
            $indices[$v] = $indexCounter;
            $lowlinks[$v] = $indexCounter;
            $indexCounter++;
            $stack[] = $v;
            $onStack[$v] = true;

            foreach ($adj[$v] ?? [] as $w) {
                if (!isset($indices[$w])) {
                    $strongConnect($w);
                    $lowlinks[$v] = min($lowlinks[$v], $lowlinks[$w]);
                } elseif (isset($onStack[$w])) {
                    $lowlinks[$v] = min($lowlinks[$v], $indices[$w]);
                }
            }

            if ($lowlinks[$v] === $indices[$v]) {
                $scc = [];
                do {
                    $w = array_pop($stack);
                    unset($onStack[$w]);
                    $scc[] = $w;
                } while ($w !== $v);

                if (count($scc) > 1) {
                    $sccs[] = $scc;
                }
            }
        };

        foreach ($nodes as $node) {
            if (!isset($indices[$node])) {
                $strongConnect($node);
            }
        }

        return $sccs;
    }

    /** Find a nullable FK edge in a cycle that can be deferred. */
    public static function findDeferrableEdge(array $cycle, array $edges): ?array
    {
        $cycleSet = array_flip($cycle);
        foreach ($edges as $e) {
            if (
                isset($cycleSet[$e['from']]) &&
                isset($cycleSet[$e['to']]) &&
                $e['from'] !== $e['to'] &&
                ($e['nullable'] ?? false) === true
            ) {
                return $e;
            }
        }
        return null;
    }
}
