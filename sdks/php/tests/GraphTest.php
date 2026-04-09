<?php

namespace Autonoma\Sdk\Tests;

use Autonoma\Sdk\Graph;
use PHPUnit\Framework\TestCase;

class GraphTest extends TestCase
{
    public function testSimpleChain(): void
    {
        $nodes = ['A', 'B', 'C'];
        $edges = [
            ['from' => 'B', 'to' => 'A', 'nullable' => false],
            ['from' => 'C', 'to' => 'B', 'nullable' => false],
        ];
        $result = Graph::topoSort($nodes, $edges);
        $this->assertSame(['A', 'B', 'C'], $result['sorted']);
        $this->assertEmpty($result['cycles']);
    }

    public function testNoEdges(): void
    {
        $nodes = ['X', 'Y', 'Z'];
        $result = Graph::topoSort($nodes, []);
        $this->assertCount(3, $result['sorted']);
        $this->assertEmpty($result['cycles']);
    }

    public function testDetectsCycle(): void
    {
        $nodes = ['A', 'B'];
        $edges = [
            ['from' => 'A', 'to' => 'B', 'nullable' => true],
            ['from' => 'B', 'to' => 'A', 'nullable' => false],
        ];
        $result = Graph::topoSort($nodes, $edges);
        $this->assertNotEmpty($result['cycles']);
    }

    public function testSelfReferentialEdgeIgnored(): void
    {
        $nodes = ['A'];
        $edges = [['from' => 'A', 'to' => 'A', 'nullable' => true]];
        $result = Graph::topoSort($nodes, $edges);
        $this->assertSame(['A'], $result['sorted']);
        $this->assertEmpty($result['cycles']);
    }

    public function testFindDeferrableEdgeReturnsNullable(): void
    {
        $cycle = ['A', 'B'];
        $edges = [
            ['from' => 'A', 'to' => 'B', 'nullable' => true],
            ['from' => 'B', 'to' => 'A', 'nullable' => false],
        ];
        $edge = Graph::findDeferrableEdge($cycle, $edges);
        $this->assertNotNull($edge);
        $this->assertTrue($edge['nullable']);
    }

    public function testFindDeferrableEdgeReturnsNullWhenNoneNullable(): void
    {
        $cycle = ['A', 'B'];
        $edges = [
            ['from' => 'A', 'to' => 'B', 'nullable' => false],
            ['from' => 'B', 'to' => 'A', 'nullable' => false],
        ];
        $this->assertNull(Graph::findDeferrableEdge($cycle, $edges));
    }

    public function testMixedCyclesAndChains(): void
    {
        $nodes = ['A', 'B', 'C', 'D'];
        $edges = [
            ['from' => 'B', 'to' => 'A', 'nullable' => false],
            ['from' => 'C', 'to' => 'D', 'nullable' => true],
            ['from' => 'D', 'to' => 'C', 'nullable' => false],
        ];
        $result = Graph::topoSort($nodes, $edges);
        // A and B should be sorted (A before B)
        $sortedPositions = array_flip($result['sorted']);
        if (isset($sortedPositions['A']) && isset($sortedPositions['B'])) {
            $this->assertLessThan($sortedPositions['B'], $sortedPositions['A']);
        }
        // C and D should be in a cycle
        $this->assertNotEmpty($result['cycles']);
    }
}
