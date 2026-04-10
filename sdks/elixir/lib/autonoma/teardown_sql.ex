defmodule Autonoma.TeardownSQL do
  @moduledoc "Tear down scoped test data via raw SQL DELETE in reverse topological order."

  alias Autonoma.Graph

  def teardown(executor, dialect, table_map, column_maps, schema, scope_value, refs \\ nil) do
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

    executor.(:transaction, fn tx ->
      # Break cycles
      for cycle <- cycles do
        edge = Graph.find_deferrable_edge(cycle, edges)

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

      # Partition sorted nodes: those that depend on cycle nodes must be deleted
      # BEFORE cycles, those that cycle nodes depend on must be deleted AFTER.
      cycle_node_set = cycles |> List.flatten() |> MapSet.new()

      if MapSet.size(cycle_node_set) > 0 do
        # Build dependency map: node → set of nodes it depends on
        depends_on = Enum.reduce(edges, %{}, fn edge, acc ->
          if edge["from"] != edge["to"] do
            Map.update(acc, edge["from"], MapSet.new([edge["to"]]), &MapSet.put(&1, edge["to"]))
          else
            acc
          end
        end)

        # Mark nodes that transitively depend on cycle nodes
        depends_on_cycle = Enum.reduce(sorted, MapSet.new(), fn node, acc ->
          deps = Map.get(depends_on, node, MapSet.new())
          if Enum.any?(deps, fn d -> MapSet.member?(cycle_node_set, d) || MapSet.member?(acc, d) end) do
            MapSet.put(acc, node)
          else
            acc
          end
        end)

        cycle_dependents = Enum.filter(sorted, fn n -> MapSet.member?(depends_on_cycle, n) end)
        cycle_deps = Enum.filter(sorted, fn n -> !MapSet.member?(depends_on_cycle, n) end)

        for model <- Enum.reverse(cycle_dependents), model != scope_root do
          delete_model(tx, dialect, table_map, column_maps, model, scope_value, scope_field_by_model, refs, schema)
        end

        for cycle <- cycles, model <- cycle do
          delete_model(tx, dialect, table_map, column_maps, model, scope_value, scope_field_by_model, refs, schema)
        end

        for model <- Enum.reverse(cycle_deps), model != scope_root do
          delete_model(tx, dialect, table_map, column_maps, model, scope_value, scope_field_by_model, refs, schema)
        end
      else
        for model <- Enum.reverse(sorted), model != scope_root do
          delete_model(tx, dialect, table_map, column_maps, model, scope_value, scope_field_by_model, refs, schema)
        end
      end

      # Delete scope root last
      if scope_root do
        db_table = Map.get(table_map, scope_root)
        col_map = Map.get(column_maps, scope_root, %{})

        if db_table do
          # Bug 4: Use schema to find actual PK field name (composite PK: prefer "id")
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

      # Bug 4: Find actual PK field name from schema
      # When multiple isId fields exist (composite PK), prefer the one named "id"
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
          # Bug 3: Accept any non-nil value, not just strings
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
