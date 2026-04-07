# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/autonoma"

class TestGraph < Minitest::Test
  def test_sorts_linear_dependency_chain
    result = Autonoma::Graph.topo_sort(
      %w[Order User Product],
      [
        { "from" => "Order", "to" => "User", "localField" => "userId", "foreignField" => "id", "nullable" => false },
        { "from" => "Order", "to" => "Product", "localField" => "productId", "foreignField" => "id", "nullable" => false }
      ]
    )
    sorted = result["sorted"]
    assert_equal 3, sorted.length
    assert_operator sorted.index("User"), :<, sorted.index("Order")
    assert_operator sorted.index("Product"), :<, sorted.index("Order")
    assert_equal [], result["cycles"]
  end

  def test_handles_nodes_with_no_edges
    result = Autonoma::Graph.topo_sort(%w[A B C], [])
    assert_equal 3, result["sorted"].length
    assert_includes result["sorted"], "A"
    assert_includes result["sorted"], "B"
    assert_includes result["sorted"], "C"
    assert_equal [], result["cycles"]
  end

  def test_detects_simple_2_node_cycle
    result = Autonoma::Graph.topo_sort(
      %w[A B],
      [
        { "from" => "A", "to" => "B", "localField" => "bId", "foreignField" => "id", "nullable" => false },
        { "from" => "B", "to" => "A", "localField" => "aId", "foreignField" => "id", "nullable" => true }
      ]
    )
    assert_equal [], result["sorted"]
    assert_equal 1, result["cycles"].length
    flat = result["cycles"].flatten
    assert_includes flat, "A"
    assert_includes flat, "B"
  end

  def test_handles_mixed_cycle_and_sorted
    result = Autonoma::Graph.topo_sort(
      %w[Root A B],
      [
        { "from" => "A", "to" => "Root", "localField" => "rootId", "foreignField" => "id", "nullable" => false },
        { "from" => "A", "to" => "B", "localField" => "bId", "foreignField" => "id", "nullable" => false },
        { "from" => "B", "to" => "A", "localField" => "aId", "foreignField" => "id", "nullable" => true }
      ]
    )
    assert_includes result["sorted"], "Root"
    flat = result["cycles"].flatten
    assert_includes flat, "A"
    assert_includes flat, "B"
  end

  def test_ignores_self_referential_edges
    result = Autonoma::Graph.topo_sort(
      ["Category"],
      [{ "from" => "Category", "to" => "Category", "localField" => "parentId", "foreignField" => "id", "nullable" => true }]
    )
    assert_equal ["Category"], result["sorted"]
    assert_equal [], result["cycles"]
  end

  def test_sorts_deep_chain
    result = Autonoma::Graph.topo_sort(
      %w[D C B A],
      [
        { "from" => "B", "to" => "A", "localField" => "aId", "foreignField" => "id", "nullable" => false },
        { "from" => "C", "to" => "B", "localField" => "bId", "foreignField" => "id", "nullable" => false },
        { "from" => "D", "to" => "C", "localField" => "cId", "foreignField" => "id", "nullable" => false }
      ]
    )
    sorted = result["sorted"]
    assert_equal 4, sorted.length
    assert_operator sorted.index("A"), :<, sorted.index("B")
    assert_operator sorted.index("B"), :<, sorted.index("C")
    assert_operator sorted.index("C"), :<, sorted.index("D")
    assert_equal [], result["cycles"]
  end

  def test_detects_3_node_cycle
    result = Autonoma::Graph.topo_sort(
      %w[A B C],
      [
        { "from" => "A", "to" => "B", "localField" => "bId", "foreignField" => "id", "nullable" => false },
        { "from" => "B", "to" => "C", "localField" => "cId", "foreignField" => "id", "nullable" => false },
        { "from" => "C", "to" => "A", "localField" => "aId", "foreignField" => "id", "nullable" => true }
      ]
    )
    assert_equal [], result["sorted"]
    assert_equal 1, result["cycles"].length
    flat = result["cycles"].flatten
    assert_includes flat, "A"
    assert_includes flat, "B"
    assert_includes flat, "C"
  end

  def test_find_deferrable_edge_finds_nullable
    edge = Autonoma::Graph.find_deferrable_edge(
      %w[A B],
      [
        { "from" => "A", "to" => "B", "localField" => "bId", "foreignField" => "id", "nullable" => false },
        { "from" => "B", "to" => "A", "localField" => "aId", "foreignField" => "id", "nullable" => true }
      ]
    )
    refute_nil edge
    assert_equal true, edge["nullable"]
  end

  def test_find_deferrable_edge_returns_nil_when_no_nullable
    edge = Autonoma::Graph.find_deferrable_edge(
      %w[A B],
      [
        { "from" => "A", "to" => "B", "localField" => "bId", "foreignField" => "id", "nullable" => false },
        { "from" => "B", "to" => "A", "localField" => "aId", "foreignField" => "id", "nullable" => false }
      ]
    )
    assert_nil edge
  end
end
