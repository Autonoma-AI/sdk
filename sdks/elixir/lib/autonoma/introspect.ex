defmodule Autonoma.Introspect do
  @moduledoc "Introspect a database via information_schema to build SchemaInfo."

  def introspect(executor, dialect, opts) do
    scope_field = Keyword.fetch!(opts, :scope_field)
    db_schema = Keyword.get(opts, :schema, if(dialect.name() != "mysql", do: "public"))

    unless db_schema do
      raise "MySQL requires a schema (database name)."
    end

    exclude = MapSet.new(Keyword.get(opts, :exclude_tables, ["_prisma_migrations"]))
    user_map = Keyword.get(opts, :table_name_map, %{})

    # Run introspection queries
    table_rows = normalize_keys(executor.(:query, dialect.tables_sql(db_schema), []))
    column_rows = normalize_keys(executor.(:query, dialect.columns_sql(db_schema), []))
    pk_rows = normalize_keys(executor.(:query, dialect.primary_keys_sql(db_schema), []))
    fk_rows = normalize_keys(executor.(:query, dialect.foreign_keys_sql(db_schema), []))
    enum_rows = normalize_keys(executor.(:query, dialect.enums_sql(db_schema), []))

    # Build enum lookup
    enum_values =
      enum_rows
      |> Enum.filter(fn r -> r["enum_name"] end)
      |> Enum.group_by(fn r -> r["enum_name"] end, fn r -> r["enum_value"] end)

    # MySQL inline enums
    enum_values =
      if dialect.name() == "mysql" do
        Enum.reduce(column_rows, enum_values, fn col, acc ->
          case parse_mysql_enum(col["udt_name"] || "") do
            nil -> acc
            vals -> Map.put(acc, "#{col["table_name"]}.#{col["column_name"]}", vals)
          end
        end)
      else
        enum_values
      end

    # PK lookup
    pks_by_table =
      Enum.group_by(pk_rows, fn r -> r["table_name"] end, fn r -> r["column_name"] end)
      |> Map.new(fn {k, v} -> {k, MapSet.new(v)} end)

    # Table name mapping
    {table_map, reverse_table_map} =
      Enum.reduce(user_map, {%{}, %{}}, fn {model, db_table}, {tm, rtm} ->
        {Map.put(tm, model, db_table), Map.put(rtm, db_table, model)}
      end)

    db_tables =
      table_rows
      |> Enum.map(fn r -> r["table_name"] end)
      |> Enum.reject(fn t -> MapSet.member?(exclude, t) end)

    {table_map, reverse_table_map} =
      Enum.reduce(db_tables, {table_map, reverse_table_map}, fn db_table, {tm, rtm} ->
        if Map.has_key?(rtm, db_table) do
          {tm, rtm}
        else
          model = snake_to_pascal(db_table)
          {Map.put(tm, model, db_table), Map.put(rtm, db_table, model)}
        end
      end)

    # Group columns by table
    cols_by_table = Enum.group_by(column_rows, fn r -> r["table_name"] end)

    # Build models, column maps, enum type maps
    {models, column_maps, enum_type_maps} =
      Enum.reduce(table_map, {[], %{}, %{}}, fn {model_name, db_table}, {m_acc, cm_acc, et_acc} ->
        cols = Map.get(cols_by_table, db_table, [])
        pks = Map.get(pks_by_table, db_table, MapSet.new())
        col_map = Map.new(cols, fn c -> {snake_to_camel(c["column_name"]), c["column_name"]} end)

        {fields, et_map} =
          Enum.reduce(cols, {[], %{}}, fn col, {f_acc, e_acc} ->
            field_name = snake_to_camel(col["column_name"])

            enum_vals =
              if dialect.name() == "mysql" do
                Map.get(enum_values, "#{col["table_name"]}.#{col["column_name"]}")
              else
                Map.get(enum_values, col["udt_name"] || "")
              end

            type =
              if enum_vals do
                "enum(#{Enum.join(enum_vals, ",")})"
              else
                map_data_type(col["data_type"], col["udt_name"] || "", dialect.name())
              end

            e_acc =
              if dialect.name() == "postgres" do
                cond do
                  enum_vals -> Map.put(e_acc, field_name, col["udt_name"] || "")
                  col["data_type"] in ["jsonb", "json"] -> Map.put(e_acc, field_name, if(col["data_type"] == "json", do: "json", else: "jsonb"))
                  String.contains?(col["data_type"] || "", "timestamp") -> Map.put(e_acc, field_name, col["udt_name"] || "")
                  true -> e_acc
                end
              else
                e_acc
              end

            field = %{
              "name" => field_name,
              "type" => type,
              "isRequired" => col["is_nullable"] == "NO",
              "isId" => MapSet.member?(pks, col["column_name"]),
              "hasDefault" => col["column_default"] != nil
            }

            {f_acc ++ [field], e_acc}
          end)

        model = %{"name" => model_name, "tableName" => db_table, "fields" => fields}
        et_acc = if map_size(et_map) > 0, do: Map.put(et_acc, model_name, et_map), else: et_acc

        {m_acc ++ [model], Map.put(cm_acc, model_name, col_map), et_acc}
      end)

    # Build FK edges
    edges =
      Enum.flat_map(fk_rows, fn fk ->
        from_model = Map.get(reverse_table_map, fk["from_table"])
        to_model = Map.get(reverse_table_map, fk["to_table"])

        if from_model && to_model do
          from_cm = Map.get(column_maps, from_model, %{})
          to_cm = Map.get(column_maps, to_model, %{})

          [%{
            "from" => from_model,
            "to" => to_model,
            "localField" => reverse_get(from_cm, fk["from_column"]) || fk["from_column"],
            "foreignField" => reverse_get(to_cm, fk["to_column"]) || fk["to_column"],
            "nullable" => fk["is_nullable"] == "YES"
          }]
        else
          []
        end
      end)

    # Build relations
    relations =
      Enum.flat_map(edges, fn edge ->
        from_db_table = Map.get(table_map, edge["from"], "")
        from_cm = Map.get(column_maps, edge["from"], %{})
        fk_db_col = Map.get(from_cm, edge["localField"], edge["localField"])
        from_pks = Map.get(pks_by_table, from_db_table, MapSet.new())
        is_one_to_one = MapSet.size(from_pks) == 1 && MapSet.member?(from_pks, fk_db_col)

        parent_field = if is_one_to_one, do: lower_first(edge["from"]), else: plural_camel_case(edge["from"])

        [
          %{
            "parentModel" => edge["to"],
            "childModel" => edge["from"],
            "parentField" => parent_field,
            "childField" => edge["localField"]
          },
          %{
            "parentModel" => edge["from"],
            "childModel" => edge["to"],
            "parentField" => lower_first(edge["to"]),
            "childField" => edge["localField"]
          }
        ]
      end)

    schema = %{
      "models" => models,
      "edges" => edges,
      "relations" => relations,
      "scopeField" => scope_field
    }

    %{
      schema: schema,
      table_map: table_map,
      column_maps: column_maps,
      enum_type_maps: enum_type_maps
    }
  end

  # --- Name mapping ---

  def snake_to_pascal(s) do
    s |> String.split("_") |> Enum.map(&String.capitalize/1) |> Enum.join()
  end

  def snake_to_camel(s) do
    pascal = snake_to_pascal(s)
    String.downcase(String.first(pascal)) <> String.slice(pascal, 1..-1//1)
  end

  defp lower_first(s), do: String.downcase(String.first(s)) <> String.slice(s, 1..-1//1)

  defp plural_camel_case(model_name) do
    lower_first(model_name) |> pluralize()
  end

  defp pluralize(s) do
    cond do
      String.ends_with?(s, ["s", "x", "z", "ch", "sh"]) -> s <> "es"
      String.ends_with?(s, "y") && String.length(s) > 1 && String.last(String.slice(s, 0..-2//1)) not in ~w(a e i o u) ->
        String.slice(s, 0..-2//1) <> "ies"
      true -> s <> "s"
    end
  end

  defp parse_mysql_enum(column_type) do
    case Regex.run(~r/^enum\((.+)\)$/i, column_type || "") do
      [_, inner] -> inner |> String.split(",") |> Enum.map(&(String.trim(&1) |> String.trim("'")))
      _ -> nil
    end
  end

  defp map_data_type(dt, udt, dialect_name) do
    dt = String.downcase(dt || "")
    cond do
      dialect_name == "mysql" && dt == "tinyint" && String.starts_with?(String.downcase(udt), "tinyint(1)") -> "Boolean"
      dt in ~w(integer smallint bigint int mediumint tinyint) -> "Int"
      dt in ~w(numeric real float double decimal) || dt == "double precision" -> "Float"
      dt in ~w(boolean) -> "Boolean"
      dt in ~w(text varchar char mediumtext longtext tinytext) || dt == "character varying" || dt == "character" -> "String"
      String.contains?(dt, "timestamp") || dt in ~w(date time datetime) -> "DateTime"
      dt in ~w(json jsonb) -> "Json"
      dt == "uuid" -> "String"
      dt in ~w(bytea blob mediumblob longblob tinyblob binary varbinary) -> "Bytes"
      dt == "user-defined" && dialect_name == "postgres" -> udt
      dt in ~w(enum set) -> udt
      true -> dt
    end
  end

  defp normalize_keys(rows) do
    Enum.map(rows, fn row ->
      Map.new(row, fn {k, v} -> {String.downcase(to_string(k)), v} end)
    end)
  end

  defp reverse_get(map, db_name) do
    Enum.find_value(map, fn {k, v} -> if v == db_name, do: k end)
  end
end
