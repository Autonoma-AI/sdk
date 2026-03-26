defmodule Autonoma.GraphTest do
  use ExUnit.Case, async: true

  alias Autonoma.Graph

  describe "topo_sort/2" do
    test "sorts a linear chain in dependency order" do
      nodes = ["A", "B", "C"]

      edges = [
        %{"from" => "B", "to" => "A", "local_field" => "a_id", "foreign_field" => "id", "nullable" => false},
        %{"from" => "C", "to" => "B", "local_field" => "b_id", "foreign_field" => "id", "nullable" => false}
      ]

      result = Graph.topo_sort(nodes, edges)

      assert result["cycles"] == []
      sorted = result["sorted"]
      assert length(sorted) == 3
      # A must come before B, B must come before C
      assert Enum.find_index(sorted, &(&1 == "A")) < Enum.find_index(sorted, &(&1 == "B"))
      assert Enum.find_index(sorted, &(&1 == "B")) < Enum.find_index(sorted, &(&1 == "C"))
    end

    test "sorts nodes with no edges in some order" do
      nodes = ["X", "Y", "Z"]
      edges = []

      result = Graph.topo_sort(nodes, edges)

      assert result["cycles"] == []
      assert Enum.sort(result["sorted"]) == ["X", "Y", "Z"]
    end

    test "detects cycles" do
      nodes = ["A", "B"]

      edges = [
        %{"from" => "A", "to" => "B", "local_field" => "b_id", "foreign_field" => "id", "nullable" => false},
        %{"from" => "B", "to" => "A", "local_field" => "a_id", "foreign_field" => "id", "nullable" => false}
      ]

      result = Graph.topo_sort(nodes, edges)

      assert result["cycles"] != []
      cycle = List.first(result["cycles"])
      assert "A" in cycle
      assert "B" in cycle
    end
  end

  describe "find_deferrable_edge/2" do
    test "finds a nullable edge in the cycle" do
      cycle = ["A", "B"]

      edges = [
        %{"from" => "A", "to" => "B", "local_field" => "b_id", "foreign_field" => "id", "nullable" => true},
        %{"from" => "B", "to" => "A", "local_field" => "a_id", "foreign_field" => "id", "nullable" => false}
      ]

      edge = Graph.find_deferrable_edge(cycle, edges)
      assert edge != nil
      assert edge["nullable"] == true
      assert edge["from"] == "A"
    end

    test "returns nil when no nullable edge exists" do
      cycle = ["A", "B"]

      edges = [
        %{"from" => "A", "to" => "B", "local_field" => "b_id", "foreign_field" => "id", "nullable" => false},
        %{"from" => "B", "to" => "A", "local_field" => "a_id", "foreign_field" => "id", "nullable" => false}
      ]

      assert Graph.find_deferrable_edge(cycle, edges) == nil
    end
  end
end
