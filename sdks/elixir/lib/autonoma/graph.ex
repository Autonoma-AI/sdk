defmodule Autonoma.Graph do
  @moduledoc """
  Topological sorting via Kahn's algorithm and cycle detection via Tarjan's SCC.
  """

  @type fk_edge :: %{
          from: String.t(),
          to: String.t(),
          local_field: String.t(),
          foreign_field: String.t(),
          nullable: boolean()
        }

  @doc """
  Topological sort of nodes by FK dependency edges.
  Returns `%{sorted: [String.t()], cycles: [[String.t()]]}`.

  After detecting cycles, runs a second pass to sort nodes that depend on
  cycle members but aren't in cycles themselves.
  """
  def topo_sort(nodes, edges) do
    # Filter to only edges between known nodes, skip self-referential
    relevant_edges =
      Enum.filter(edges, fn e ->
        e_from = to_string(e["from"] || e[:from])
        e_to = to_string(e["to"] || e[:to])
        e_from != e_to && e_from in nodes && e_to in nodes
      end)

    # Build in-degree map and adjacency list
    in_degree = Map.new(nodes, fn n -> {n, 0} end)
    adj = Map.new(nodes, fn n -> {n, []} end)

    {in_degree, adj} =
      Enum.reduce(relevant_edges, {in_degree, adj}, fn e, {deg, a} ->
        e_from = to_string(e["from"] || e[:from])
        e_to = to_string(e["to"] || e[:to])
        # e_from depends on e_to (from has the FK pointing to to)
        new_adj = Map.update!(a, e_to, fn neighbors -> [e_from | neighbors] end)
        new_deg = Map.update!(deg, e_from, fn d -> d + 1 end)
        {new_deg, new_adj}
      end)

    # First pass: standard Kahn's
    queue = in_degree |> Enum.filter(fn {_, d} -> d == 0 end) |> Enum.map(fn {n, _} -> n end) |> Enum.sort()
    {sorted, in_degree} = kahns_loop(queue, adj, in_degree, [])

    # Find unsorted nodes
    unsorted = Enum.filter(nodes, fn n -> n not in sorted end)

    cycles =
      if unsorted == [] do
        []
      else
        find_sccs(unsorted, relevant_edges)
      end

    if cycles == [] do
      %{"sorted" => sorted, "cycles" => []}
    else
      # Second pass: treat cycle nodes as resolved and re-sort remaining
      cycle_nodes = cycles |> List.flatten() |> MapSet.new()
      still_unsorted = Enum.filter(unsorted, fn n -> n not in cycle_nodes end)

      sorted =
        if still_unsorted != [] do
          in_deg2 = Map.new(still_unsorted, fn n -> {n, 0} end)
          adj2 = Map.new(still_unsorted, fn n -> {n, []} end)
          still_set = MapSet.new(still_unsorted)

          {in_deg2, adj2} =
            Enum.reduce(relevant_edges, {in_deg2, adj2}, fn e, {deg, a} ->
              e_from = to_string(e["from"] || e[:from])
              e_to = to_string(e["to"] || e[:to])

              if MapSet.member?(still_set, e_from) && MapSet.member?(still_set, e_to) do
                new_adj = Map.update!(a, e_to, fn neighbors -> [e_from | neighbors] end)
                new_deg = Map.update!(deg, e_from, fn d -> d + 1 end)
                {new_deg, new_adj}
              else
                {deg, a}
              end
            end)

          queue2 = in_deg2 |> Enum.filter(fn {_, d} -> d == 0 end) |> Enum.map(fn {n, _} -> n end) |> Enum.sort()
          {extra_sorted, _} = kahns_loop(queue2, adj2, in_deg2, [])
          sorted ++ extra_sorted
        else
          sorted
        end

      %{"sorted" => sorted, "cycles" => cycles}
    end
  end

  defp kahns_loop([], _adj, in_degree, sorted), do: {sorted, in_degree}

  defp kahns_loop([node | rest], adj, in_degree, sorted) do
    neighbors = Map.get(adj, node, [])

    {new_queue_additions, in_degree} =
      Enum.reduce(neighbors, {[], in_degree}, fn neighbor, {additions, deg} ->
        new_deg = Map.get(deg, neighbor, 1) - 1
        deg = Map.put(deg, neighbor, new_deg)

        if new_deg == 0 do
          {[neighbor | additions], deg}
        else
          {additions, deg}
        end
      end)

    new_queue = (rest ++ new_queue_additions) |> Enum.sort()
    kahns_loop(new_queue, adj, in_degree, sorted ++ [node])
  end

  @doc """
  Tarjan's SCC algorithm to identify exact cycles among remaining nodes.
  Returns only SCCs with more than 1 node.
  """
  def find_sccs(nodes, edges) do
    node_set = MapSet.new(nodes)

    adj =
      Enum.reduce(edges, Map.new(nodes, fn n -> {n, []} end), fn e, acc ->
        e_from = to_string(e["from"] || e[:from])
        e_to = to_string(e["to"] || e[:to])

        if MapSet.member?(node_set, e_from) && MapSet.member?(node_set, e_to) do
          Map.update!(acc, e_to, fn neighbors -> [e_from | neighbors] end)
        else
          acc
        end
      end)

    state = %{index: 0, stack: [], on_stack: MapSet.new(), indices: %{}, lowlinks: %{}, sccs: []}

    state =
      Enum.reduce(nodes, state, fn node, state ->
        if Map.has_key?(state.indices, node) do
          state
        else
          strong_connect(node, adj, state)
        end
      end)

    state.sccs
  end

  defp strong_connect(v, adj, state) do
    state = %{
      state
      | index: state.index + 1,
        stack: [v | state.stack],
        on_stack: MapSet.put(state.on_stack, v),
        indices: Map.put(state.indices, v, state.index),
        lowlinks: Map.put(state.lowlinks, v, state.index)
    }

    state =
      Enum.reduce(Map.get(adj, v, []), state, fn w, state ->
        cond do
          not Map.has_key?(state.indices, w) ->
            state = strong_connect(w, adj, state)
            lowlink = min(Map.get(state.lowlinks, v), Map.get(state.lowlinks, w))
            %{state | lowlinks: Map.put(state.lowlinks, v, lowlink)}

          MapSet.member?(state.on_stack, w) ->
            lowlink = min(Map.get(state.lowlinks, v), Map.get(state.indices, w))
            %{state | lowlinks: Map.put(state.lowlinks, v, lowlink)}

          true ->
            state
        end
      end)

    if Map.get(state.lowlinks, v) == Map.get(state.indices, v) do
      {scc, stack, on_stack} = pop_scc(state.stack, state.on_stack, v, [])
      state = %{state | stack: stack, on_stack: on_stack}

      if length(scc) > 1 do
        %{state | sccs: state.sccs ++ [scc]}
      else
        state
      end
    else
      state
    end
  end

  defp pop_scc([w | rest], on_stack, v, scc) do
    on_stack = MapSet.delete(on_stack, w)
    scc = scc ++ [w]

    if w == v do
      {scc, rest, on_stack}
    else
      pop_scc(rest, on_stack, v, scc)
    end
  end

  @doc """
  Find a nullable FK edge in a cycle that can be deferred.
  Returns the edge or nil.
  """
  def find_deferrable_edge(cycle, edges) do
    cycle_set = MapSet.new(cycle)

    Enum.find(edges, fn e ->
      e_from = to_string(e["from"] || e[:from])
      e_to = to_string(e["to"] || e[:to])
      nullable = e["nullable"] || e[:nullable]

      MapSet.member?(cycle_set, e_from) &&
        MapSet.member?(cycle_set, e_to) &&
        e_from != e_to &&
        nullable == true
    end)
  end
end
