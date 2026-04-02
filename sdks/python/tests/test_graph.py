"""Tests for graph.py — topo_sort and find_deferrable_edge."""

from autonoma.graph import topo_sort, find_deferrable_edge


class TestTopoSort:
    def test_linear_chain_sorts_correctly(self):
        # A -> B -> C  (A depends on B, B depends on C)
        nodes = ["A", "B", "C"]
        edges = [
            {"from": "A", "to": "B"},
            {"from": "B", "to": "C"},
        ]
        result = topo_sort(nodes, edges)
        assert result["cycles"] == []
        sorted_nodes = result["sorted"]
        assert sorted_nodes.index("C") < sorted_nodes.index("B")
        assert sorted_nodes.index("B") < sorted_nodes.index("A")

    def test_nodes_with_no_edges(self):
        nodes = ["X", "Y", "Z"]
        result = topo_sort(nodes, [])
        assert result["cycles"] == []
        assert set(result["sorted"]) == {"X", "Y", "Z"}

    def test_detects_cycles(self):
        nodes = ["A", "B"]
        edges = [
            {"from": "A", "to": "B"},
            {"from": "B", "to": "A"},
        ]
        result = topo_sort(nodes, edges)
        assert len(result["cycles"]) > 0
        cycle = result["cycles"][0]
        assert set(cycle) == {"A", "B"}

    def test_self_referential_edges_ignored(self):
        nodes = ["A", "B"]
        edges = [
            {"from": "A", "to": "A"},
            {"from": "A", "to": "B"},
        ]
        result = topo_sort(nodes, edges)
        assert result["cycles"] == []
        sorted_nodes = result["sorted"]
        assert sorted_nodes.index("B") < sorted_nodes.index("A")


class TestFindDeferrableEdge:
    def test_finds_nullable_edge_in_cycle(self):
        cycle = ["A", "B"]
        edges = [
            {"from": "A", "to": "B", "nullable": True},
            {"from": "B", "to": "A", "nullable": False},
        ]
        result = find_deferrable_edge(cycle, edges)
        assert result is not None
        assert result["from"] == "A"
        assert result["to"] == "B"
        assert result["nullable"] is True

    def test_returns_none_when_no_nullable_edge(self):
        cycle = ["A", "B"]
        edges = [
            {"from": "A", "to": "B", "nullable": False},
            {"from": "B", "to": "A", "nullable": False},
        ]
        result = find_deferrable_edge(cycle, edges)
        assert result is None
