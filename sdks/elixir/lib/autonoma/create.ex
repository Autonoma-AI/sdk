defmodule Autonoma.Create do
  @moduledoc "Create entities via raw SQL INSERT."

  @mysql_datetime_re ~r/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

  def create_entities(executor, dialect, table_map, column_maps, spec, enum_type_maps \\ %{}, schema_models \\ []) do
    Enum.reduce(spec, %{}, fn {model, entity_spec}, acc ->
      db_table = Map.get(table_map, model) || raise "Unknown model \"#{model}\"."
      col_map = Map.get(column_maps, model, %{})
      enum_type_map = Map.get(enum_type_maps, model, %{})
      fields_list = Map.get(entity_spec, "fields", [])
      is_batch = Map.get(entity_spec, "batch", false)

      # Bug 4: find actual PK field name from schema
      model_info = Enum.find(schema_models, fn m -> m["name"] == model end)
      pk_field = if model_info, do: Enum.find(model_info["fields"] || [], fn f -> f["isId"] end)
      pk_field_name = if pk_field, do: pk_field["name"], else: "id"
      pk_field_type = if pk_field, do: pk_field["type"], else: "String"

      records =
        if is_batch && length(fields_list) > 0 do
          insert_batch(executor, dialect, db_table, col_map, enum_type_map, fields_list, pk_field_name, pk_field_type)
        else
          Enum.flat_map(fields_list, fn fields ->
            insert_one(executor, dialect, db_table, col_map, enum_type_map, fields, pk_field_name, pk_field_type)
          end)
        end

      Map.put(acc, model, records)
    end)
  end

  def update_entity(executor, dialect, table_map, column_maps, model, record_id, fields, enum_type_maps \\ %{}, pk_field_name \\ "id") do
    db_table = Map.get(table_map, model) || raise "Unknown model \"#{model}\" for update."
    col_map = Map.get(column_maps, model, %{})
    enum_type_map = Map.get(enum_type_maps, model, %{})

    {set_clauses, params, param_idx} =
      Enum.reduce(fields, {[], [], 1}, fn {field_name, value}, {clauses, ps, idx} ->
        db_col = Map.get(col_map, field_name, field_name)
        clause = "#{dialect.quote_id(db_col)} = #{cast_param(dialect, idx, enum_type_map, field_name)}"
        {clauses ++ [clause], ps ++ [serialize_value(value, dialect)], idx + 1}
      end)

    id_col = Map.get(col_map, pk_field_name, pk_field_name)
    sql = "UPDATE #{dialect.quote_id(db_table)} SET #{Enum.join(set_clauses, ", ")} WHERE #{dialect.quote_id(id_col)} = #{dialect.param(param_idx)}"
    executor.(:query, sql, params ++ [record_id])
  end

  # --- Internal ---

  defp insert_one(executor, dialect, db_table, col_map, enum_type_map, fields, pk_field_name \\ "id", pk_field_type \\ "String") do
    # Bug 1: Only generate UUID when PK type is String; Int/BigInt use DB auto-increment
    fields =
      if pk_field_name && !Map.has_key?(fields, pk_field_name) && pk_field_type == "String" do
        Map.put(fields, pk_field_name, UUID.uuid4())
      else
        fields
      end

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
        id_col = Map.get(col_map, pk_field_name, pk_field_name)
        record_id = Map.get(fields, pk_field_name)
        executor.(:query, "SELECT * FROM #{dialect.quote_id(db_table)} WHERE #{dialect.quote_id(id_col)} = #{dialect.param(1)}", [record_id])
        |> map_rows_back(col_map)
      end
    end
  end

  defp insert_batch(_executor, _dialect, _db_table, _col_map, _enum_type_map, []), do: []

  defp insert_batch(executor, dialect, db_table, col_map, enum_type_map, fields_arr, pk_field_name \\ "id", pk_field_type \\ "String") do

    # Bug 1: Only generate client-side IDs when PK type is String; Int/BigInt use DB auto-increment
    fields_arr =
      if pk_field_name && pk_field_type == "String" do
        Enum.map(fields_arr, fn f ->
          if Map.has_key?(f, pk_field_name), do: f, else: Map.put(f, pk_field_name, UUID.uuid4())
        end)
      else
        fields_arr
      end

    field_names =
      fields_arr
      |> Enum.flat_map(&Map.keys/1)
      |> Enum.uniq()
      |> Enum.sort()

    if field_names == [] do
      Enum.flat_map(fields_arr, fn fields ->
        insert_one(executor, dialect, db_table, col_map, enum_type_map, fields)
      end)
    else
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
  end

  defp map_rows_back(rows, col_map) do
    reverse = Map.new(col_map, fn {field, db_col} -> {db_col, field} end)
    Enum.map(rows, fn row ->
      Map.new(row, fn {k, v} -> {Map.get(reverse, k, k), v} end)
    end)
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
  # Bug 2: Only JSON-encode maps/dicts, NOT lists. Return lists as native values for Postgres ARRAY columns.
  defp serialize_value(value, _dialect) when is_map(value), do: Jason.encode!(value)
  defp serialize_value(value, _dialect) when is_list(value), do: value
  defp serialize_value(value, dialect) when is_binary(value) do
    if dialect.name() == "mysql" && Regex.match?(@mysql_datetime_re, value) do
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
