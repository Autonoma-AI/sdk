defmodule Autonoma.Create do
  @moduledoc "Create entities via raw SQL INSERT."

  def create_entities(executor, dialect, table_map, column_maps, spec, enum_type_maps \\ %{}) do
    Enum.reduce(spec, %{}, fn {model, entity_spec}, acc ->
      db_table = Map.get(table_map, model) || raise "Unknown model \"#{model}\"."
      col_map = Map.get(column_maps, model, %{})
      enum_type_map = Map.get(enum_type_maps, model, %{})
      fields_list = Map.get(entity_spec, "fields", [])
      is_batch = Map.get(entity_spec, "batch", false)

      records =
        if is_batch && length(fields_list) > 0 do
          insert_batch(executor, dialect, db_table, col_map, enum_type_map, fields_list)
        else
          Enum.flat_map(fields_list, fn fields ->
            insert_one(executor, dialect, db_table, col_map, enum_type_map, fields)
          end)
        end

      Map.put(acc, model, records)
    end)
  end

  def update_entity(executor, dialect, table_map, column_maps, model, record_id, fields, enum_type_maps \\ %{}) do
    db_table = Map.get(table_map, model) || raise "Unknown model \"#{model}\" for update."
    col_map = Map.get(column_maps, model, %{})
    enum_type_map = Map.get(enum_type_maps, model, %{})

    {set_clauses, params, param_idx} =
      Enum.reduce(fields, {[], [], 1}, fn {field_name, value}, {clauses, ps, idx} ->
        db_col = Map.get(col_map, field_name, field_name)
        clause = "#{dialect.quote_id(db_col)} = #{cast_param(dialect, idx, enum_type_map, field_name)}"
        {clauses ++ [clause], ps ++ [serialize_value(value, dialect)], idx + 1}
      end)

    id_col = Map.get(col_map, "id", "id")
    sql = "UPDATE #{dialect.quote_id(db_table)} SET #{Enum.join(set_clauses, ", ")} WHERE #{dialect.quote_id(id_col)} = #{dialect.param(param_idx)}"
    executor.(:query, sql, params ++ [record_id])
  end

  # --- Internal ---

  defp insert_one(executor, dialect, db_table, col_map, enum_type_map, fields) do
    # Generate client-side UUID for 'id' column
    id_field = reverse_get(col_map, find_id_col(col_map))
    fields = if id_field && !Map.has_key?(fields, id_field), do: Map.put(fields, id_field, UUID.uuid4()), else: fields

    entries = Map.to_list(fields)

    if entries == [] do
      executor.(:query, "INSERT INTO #{dialect.quote_id(db_table)} DEFAULT VALUES RETURNING *", [])
      |> map_rows_back(col_map)
    else
      {db_cols, placeholders, params, _} =
        Enum.reduce(entries, {[], [], [], 1}, fn {field_name, value}, {cols, phs, ps, idx} ->
          db_col = Map.get(col_map, field_name, field_name)
          {
            cols ++ [dialect.quote_id(db_col)],
            phs ++ [cast_param(dialect, idx, enum_type_map, field_name)],
            ps ++ [serialize_value(value, dialect)],
            idx + 1
          }
        end)

      col_list = Enum.join(db_cols, ", ")
      val_list = Enum.join(placeholders, ", ")

      if dialect.supports_returning() do
        sql = "INSERT INTO #{dialect.quote_id(db_table)} (#{col_list}) VALUES (#{val_list}) RETURNING *"
        executor.(:query, sql, params) |> map_rows_back(col_map)
      else
        executor.(:query, "INSERT INTO #{dialect.quote_id(db_table)} (#{col_list}) VALUES (#{val_list})", params)
        id_col = find_id_col(col_map)
        record_id = Map.get(fields, id_field || "id")
        executor.(:query, "SELECT * FROM #{dialect.quote_id(db_table)} WHERE #{dialect.quote_id(id_col)} = #{dialect.param(1)}", [record_id])
        |> map_rows_back(col_map)
      end
    end
  end

  defp insert_batch(_executor, _dialect, _db_table, _col_map, _enum_type_map, []), do: []

  defp insert_batch(executor, dialect, db_table, col_map, enum_type_map, fields_arr) do

    # Generate client-side IDs
    id_field = reverse_get(col_map, find_id_col(col_map))
    fields_arr =
      if id_field do
        Enum.map(fields_arr, fn f ->
          if Map.has_key?(f, id_field), do: f, else: Map.put(f, id_field, UUID.uuid4())
        end)
      else
        fields_arr
      end

    field_names = Map.keys(List.first(fields_arr))
    db_cols = Enum.map(field_names, fn f -> dialect.quote_id(Map.get(col_map, f, f)) end)
    col_list = Enum.join(db_cols, ", ")

    # Chunk for bind var limits
    max_params = 32_000
    chunk_size = max(1, div(max_params, length(field_names)))

    fields_arr
    |> Enum.chunk_every(chunk_size)
    |> Enum.flat_map(fn chunk ->
      {tuples, params, _} =
        Enum.reduce(chunk, {[], [], 1}, fn fields, {ts, ps, idx} ->
          {phs, ps2, idx2} =
            Enum.reduce(field_names, {[], ps, idx}, fn fn_name, {ph_acc, p_acc, i} ->
              {
                ph_acc ++ [cast_param(dialect, i, enum_type_map, fn_name)],
                p_acc ++ [serialize_value(Map.get(fields, fn_name), dialect)],
                i + 1
              }
            end)
          {ts ++ ["(#{Enum.join(phs, ", ")})"], ps2, idx2}
        end)

      val_list = Enum.join(tuples, ", ")

      if dialect.supports_returning() do
        sql = "INSERT INTO #{dialect.quote_id(db_table)} (#{col_list}) VALUES #{val_list} RETURNING *"
        executor.(:query, sql, params) |> map_rows_back(col_map)
      else
        executor.(:query, "INSERT INTO #{dialect.quote_id(db_table)} (#{col_list}) VALUES #{val_list}", params)
        []
      end
    end)
  end

  defp map_rows_back(rows, col_map) do
    reverse = Map.new(col_map, fn {field, db_col} -> {db_col, field} end)
    Enum.map(rows, fn row ->
      Map.new(row, fn {k, v} -> {Map.get(reverse, k, k), v} end)
    end)
  end

  defp find_id_col(col_map), do: Map.get(col_map, "id", "id")

  defp reverse_get(map, db_name) do
    Enum.find_value(map, fn {k, v} -> if v == db_name, do: k end)
  end

  defp cast_param(dialect, idx, enum_type_map, field_name) do
    placeholder = dialect.param(idx)
    if dialect.name() == "postgres" do
      case Map.get(enum_type_map, field_name) do
        nil -> placeholder
        enum_type -> "#{placeholder}::#{dialect.quote_id(enum_type)}"
      end
    else
      placeholder
    end
  end

  defp serialize_value(nil, _dialect), do: nil
  defp serialize_value(%DateTime{} = dt, dialect) do
    if dialect.name() == "mysql" do
      Calendar.strftime(dt, "%Y-%m-%d %H:%M:%S")
    else
      DateTime.to_iso8601(dt)
    end
  end
  defp serialize_value(value, _dialect) when is_map(value) or is_list(value), do: Jason.encode!(value)
  defp serialize_value(value, dialect) when is_binary(value) do
    if dialect.name() == "mysql" && Regex.match?(~r/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, value) do
      value |> String.replace("T", " ") |> String.replace("Z", "") |> String.replace(~r/\.\d+$/, "")
    else
      value
    end
  end
  defp serialize_value(value, _dialect), do: value
end

# Minimal UUID generation (no external dep needed)
defmodule UUID do
  @moduledoc false
  def uuid4 do
    <<a::32, b::16, c::16, d::16, e::48>> = :crypto.strong_rand_bytes(16)
    :io_lib.format("~8.16.0b-~4.16.0b-~4.16.0b-~4.16.0b-~12.16.0b", [a, b, c, d, e])
    |> to_string()
  end
end
