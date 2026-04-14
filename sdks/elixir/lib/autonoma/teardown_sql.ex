defmodule Autonoma.TeardownSQL do
  @moduledoc "Tear down scoped test data via raw SQL DELETE in reverse topological order."

  alias Autonoma.Graph

  @doc """
  Compute the teardown order for models (reverse topological order).

  Returns a map with:
    - `order`: list of model names in deletion order (excluding scope root)
    - `scope_root`: the scope root model name (deleted last), or nil
    - `cycles`: list of cycle lists
    - `scope_field_by_model`: map of model -> FK field pointing to scope root
  """
  def compute_teardown_order(schema) do
    edges = schema["edges"]

    # Find scope root model
    scope_root =
      Enum.find_value(edges, fn edge ->
        if String.downcase(edge["localField"]) == String.downcase(schema["scopeField"]) &&
             edge["to"] != edge["from"] do
          edge["to"]
        end
      end)

    # Build scope FK map
    scope_field_by_model =
      if scope_root do
        edges
        |> Enum.filter(fn e -> e["to"] == scope_root && e["from"] != scope_root end)
        |> Map.new(fn e -> {e["from"], e["localField"]} end)
      else
        %{}
      end

    model_names = Enum.map(schema["models"], fn m -> m["name"] end)
    %{"sorted" => sorted, "cycles" => cycles} = Graph.topo_sort(model_names, edges)

    # Build condensation graph
    {components, node_to_comp} =
      Enum.reduce(cycles, {[], %{}}, fn cycle, {comps, mapping} ->
        idx = length(comps)
        new_mapping = Enum.reduce(cycle, mapping, fn node, acc -> Map.put(acc, node, idx) end)
        {comps ++ [cycle], new_mapping}
      end)

    {components, node_to_comp} =
      Enum.reduce(sorted, {components, node_to_comp}, fn node, {comps, mapping} ->
        {comps ++ [[node]], Map.put(mapping, node, length(comps))}
      end)

    comp_count = length(components)
    indices = if comp_count > 0, do: 0..(comp_count - 1), else: []

    # Build condensation DAG edges (dependency -> dependent)
    init_adj = Map.new(indices, fn i -> {i, MapSet.new()} end)
    init_deg = Map.new(indices, fn i -> {i, 0} end)

    {cond_adj, cond_in_deg} =
      Enum.reduce(edges, {init_adj, init_deg}, fn edge, {adj, deg} ->
        if edge["from"] == edge["to"] do
          {adj, deg}
        else
          fc = Map.get(node_to_comp, edge["from"])
          tc = Map.get(node_to_comp, edge["to"])
          if fc != nil && tc != nil && fc != tc && !MapSet.member?(Map.get(adj, tc, MapSet.new()), fc) do
            {Map.update!(adj, tc, &MapSet.put(&1, fc)),
             Map.update!(deg, fc, &(&1 + 1))}
          else
            {adj, deg}
          end
        end
      end)

    # Kahn's algorithm on the condensation DAG
    init_queue = cond_in_deg |> Enum.filter(fn {_i, d} -> d == 0 end) |> Enum.map(fn {i, _} -> i end) |> Enum.sort()

    {cond_order, _} =
      Enum.reduce_while(Stream.cycle([nil]), {[], {init_queue, cond_adj, cond_in_deg}}, fn _, {order, {queue, adj, deg}} ->
        case queue do
          [] -> {:halt, {order, {queue, adj, deg}}}
          _ ->
            sorted_q = Enum.sort(queue)
            [idx | rest] = sorted_q
            neighbors = Map.get(adj, idx, MapSet.new())
            {new_queue, new_deg} = Enum.reduce(neighbors, {rest, deg}, fn n, {q, d} ->
              nd = Map.get(d, n, 1) - 1
              d = Map.put(d, n, nd)
              q = if nd == 0, do: [n | q], else: q
              {q, d}
            end)
            {:cont, {order ++ [idx], {new_queue, adj, new_deg}}}
        end
      end)

    # Flatten in reverse condensation order, excluding scope root
    order =
      cond_order
      |> Enum.reverse()
      |> Enum.flat_map(fn comp_idx ->
        Enum.at(components, comp_idx)
        |> Enum.reject(fn model -> model == scope_root end)
      end)

    %{
      order: order,
      scope_root: scope_root,
      cycles: cycles,
      scope_field_by_model: scope_field_by_model
    }
  end

  def teardown(executor, dialect, table_map, column_maps, schema, scope_value, refs \\ nil, skip_models \\ MapSet.new()) do
    %{
      order: order,
      scope_root: scope_root,
      cycles: cycles,
      scope_field_by_model: scope_field_by_model
    } = compute_teardown_order(schema)

    # Normalize skip_models to a MapSet
    skip_models =
      cond do
        is_struct(skip_models, MapSet) -> skip_models
        is_map(skip_models) -> MapSet.new(Map.keys(skip_models))
        is_list(skip_models) -> MapSet.new(skip_models)
        true -> MapSet.new()
      end

    executor.(:transaction, fn tx ->
      # Break cycles
      for cycle <- cycles do
        edge = Graph.find_deferrable_edge(cycle, schema["edges"])

        if edge do
          scope_fk = Map.get(scope_field_by_model, edge["from"])

          if scope_fk do
            db_table = Map.get(table_map, edge["from"])
            col_map = Map.get(column_maps, edge["from"], %{})

            if db_table do
              db_fk_col = Map.get(col_map, edge["localField"], edge["localField"])
              db_scope_col = Map.get(col_map, scope_fk, scope_fk)

              tx.(:query,
                "UPDATE #{dialect.quote_id(db_table)} SET #{dialect.quote_id(db_fk_col)} = NULL WHERE #{dialect.quote_id(db_scope_col)} = #{dialect.param(1)}",
                [scope_value])
            end
          end
        end
      end

      # Delete in reverse condensation order (dependents first), skipping factory-teardown models
      for model <- order,
          !MapSet.member?(skip_models, model),
          model != scope_root do
        delete_model(tx, dialect, table_map, column_maps, model, scope_value, scope_field_by_model, refs, schema)
      end

      # Delete scope root last (unless skipped by factory teardown)
      if scope_root && !MapSet.member?(skip_models, scope_root) do
        db_table = Map.get(table_map, scope_root)
        col_map = Map.get(column_maps, scope_root, %{})

        if db_table do
          root_model_info = Enum.find(schema["models"] || [], fn m -> m["name"] == scope_root end)
          root_pk_field_name =
            if root_model_info do
              id_fields = Enum.filter(root_model_info["fields"] || [], fn f -> f["isId"] end)
              pk = Enum.find(id_fields, List.first(id_fields), fn f -> String.downcase(f["name"]) == "id" end)
              if pk, do: pk["name"], else: "id"
            else
              "id"
            end
          id_col = Map.get(col_map, root_pk_field_name, root_pk_field_name)
          tx.(:query,
            "DELETE FROM #{dialect.quote_id(db_table)} WHERE #{dialect.quote_id(id_col)} = #{dialect.param(1)}",
            [scope_value])
        end
      end
    end, nil)
  end

  defp delete_model(tx, dialect, table_map, column_maps, model, scope_value, scope_field_by_model, refs, schema) do
    db_table = Map.get(table_map, model)

    if db_table do
      col_map = Map.get(column_maps, model, %{})
      scope_fk = Map.get(scope_field_by_model, model)

      model_info = Enum.find(schema["models"] || [], fn m -> m["name"] == model end)
      pk_field_name =
        if model_info do
          id_fields = Enum.filter(model_info["fields"] || [], fn f -> f["isId"] end)
          pk = Enum.find(id_fields, List.first(id_fields), fn f -> String.downcase(f["name"]) == "id" end)
          if pk, do: pk["name"], else: "id"
        else
          "id"
        end

      cond do
        scope_fk ->
          db_col = Map.get(col_map, scope_fk, scope_fk)
          tx.(:query,
            "DELETE FROM #{dialect.quote_id(db_table)} WHERE #{dialect.quote_id(db_col)} = #{dialect.param(1)}",
            [scope_value])

        refs && Map.has_key?(refs, model) ->
          ids = refs[model] |> Enum.map(fn r -> r[pk_field_name] end) |> Enum.filter(fn id -> id != nil end)

          if ids != [] do
            id_col = Map.get(col_map, pk_field_name, pk_field_name)
            placeholders = Enum.map_join(1..length(ids), ", ", fn i -> dialect.param(i) end)
            tx.(:query,
              "DELETE FROM #{dialect.quote_id(db_table)} WHERE #{dialect.quote_id(id_col)} IN (#{placeholders})",
              ids)
          end

        true -> :ok
      end
    end
  end
end
