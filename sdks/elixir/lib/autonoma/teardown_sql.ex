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

      # Bug 6: Delete non-cycle nodes in reverse topo order FIRST (dependents before cycle nodes)
      for model <- Enum.reverse(sorted), model != scope_root do
        delete_model(tx, dialect, table_map, column_maps, model, scope_value, scope_field_by_model, refs, schema)
      end

      # Delete cycle nodes AFTER their non-cycle dependents are gone
      for cycle <- cycles, model <- cycle do
        delete_model(tx, dialect, table_map, column_maps, model, scope_value, scope_field_by_model, refs, schema)
      end

      # Delete scope root last
      if scope_root do
        db_table = Map.get(table_map, scope_root)
        col_map = Map.get(column_maps, scope_root, %{})

        if db_table do
          # Bug 4: Use schema to find actual PK field name
          root_model_info = Enum.find(schema["models"] || [], fn m -> m["name"] == scope_root end)
          root_pk_field_name =
            if root_model_info do
              pk = Enum.find(root_model_info["fields"] || [], fn f -> f["isId"] end)
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
      model_info = Enum.find(schema["models"] || [], fn m -> m["name"] == model end)
      pk_field_name =
        if model_info do
          pk = Enum.find(model_info["fields"] || [], fn f -> f["isId"] end)
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
