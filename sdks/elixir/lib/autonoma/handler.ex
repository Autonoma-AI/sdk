defmodule Autonoma.Handler do
  @moduledoc """
  Request routing for discover/up/down protocol actions.
  Supports both SQL-first (executor) and legacy (adapter) config paths.
  """

  alias Autonoma.{Error, HMAC, Refs, Dialect, Introspect, Tree, Create, TeardownSQL}

  @protocol_version_file Path.expand("../../../../protocol/version.txt", __DIR__)
  @external_resource @protocol_version_file
  @protocol_version File.read!(@protocol_version_file) |> String.trim()

  # ---------------------------------------------------------------------------
  # Introspection cache (per config, stored in process dictionary)
  # ---------------------------------------------------------------------------

  defp get_introspection(config) do
    cache_key = {:autonoma_introspection_cache, :erlang.phash2(config)}

    case Process.get(cache_key) do
      nil ->
        dialect = get_dialect(config)
        result = Introspect.introspect(config.executor, dialect, [
          scope_field: config.scope_field,
          schema: Map.get(config, :db_schema),
          table_name_map: Map.get(config, :table_name_map),
          exclude_tables: Map.get(config, :exclude_tables, ["_prisma_migrations"])
        ])
        Process.put(cache_key, result)
        result
      cached ->
        cached
    end
  end

  defp get_dialect(config) do
    dialect_name = Map.get(config, :dialect) || "postgres"
    Dialect.get(dialect_name)
  end

  # ---------------------------------------------------------------------------
  # SDK metadata
  # ---------------------------------------------------------------------------

  defp build_sdk_meta(config) do
    sdk = Map.get(config, :sdk, %{})

    orm =
      cond do
        Map.has_key?(sdk, "orm") -> sdk["orm"]
        Map.has_key?(sdk, :orm) -> sdk[:orm]
        Map.has_key?(config, :adapter) -> get_adapter_name(config.adapter)
        true -> "unknown"
      end

    server =
      cond do
        Map.has_key?(sdk, "server") -> sdk["server"]
        Map.has_key?(sdk, :server) -> sdk[:server]
        Map.has_key?(config, :sdk_server) -> config.sdk_server
        true -> "unknown"
      end

    %{
      "version" => @protocol_version,
      "sdk" => %{
        "language" => "elixir",
        "orm" => orm,
        "server" => server
      }
    }
  end

  defp get_adapter_name(%Autonoma.Ecto.Adapter{}), do: "ecto"
  defp get_adapter_name(%{name: name}), do: name
  defp get_adapter_name(_), do: "unknown"

  # ---------------------------------------------------------------------------
  # Main entry point
  # ---------------------------------------------------------------------------

  def handle(config, req) do
    try do
      if config.shared_secret == config.signing_secret do
        raise Error.same_secrets()
      end

      if !Map.get(config, :allow_production, false) && System.get_env("MIX_ENV") == "prod" do
        raise Error.production_blocked()
      end

      signature =
        Map.get(req.headers, "x-signature") ||
          Map.get(req.headers, "X-Signature") ||
          ""

      unless HMAC.verify_signature(req.body, signature, config.shared_secret) do
        raise Error.invalid_signature()
      end

      body =
        case Jason.decode(req.body) do
          {:ok, parsed} -> parsed
          {:error, _} -> raise Error.invalid_body("invalid JSON")
        end

      action = Map.get(body, "action")
      unless action, do: raise(Error.invalid_body("missing action"))

      sql_first? = Map.has_key?(config, :executor)

      case action do
        "discover" ->
          if sql_first?, do: handle_discover_sql(config), else: handle_discover_legacy(config)
        "up" ->
          if sql_first?, do: handle_up_sql(config, body), else: handle_up_legacy(config, body)
        "down" ->
          if sql_first?, do: handle_down_sql(config, body), else: handle_down_legacy(config, body)
        other ->
          raise Error.unknown_action(other)
      end
    rescue
      e in Error ->
        %{status: e.status, body: %{"error" => e.message, "code" => e.code}}

      e ->
        %{status: 500, body: %{"error" => Exception.message(e), "code" => "INTERNAL_ERROR"}}
    end
  end

  # ===========================================================================
  # SQL-first path (executor-based)
  # ===========================================================================

  defp handle_discover_sql(config) do
    %{schema: schema} = get_introspection(config)
    %{status: 200, body: Map.merge(build_sdk_meta(config), %{"schema" => schema})}
  end

  defp handle_up_sql(config, body) do
    create = Map.get(body, "create")
    unless create, do: raise(Error.invalid_body("missing \"create\" in request body"))

    test_run_id = Map.get(body, "testRunId", generate_uuid())
    %{schema: schema, table_map: table_map, column_maps: column_maps, enum_type_maps: enum_type_maps} =
      get_introspection(config)

    dialect = get_dialect(config)
    tree = Tree.resolve_tree(create, schema, test_run_id)

    refs = %{}
    id_map = %{}

    {refs, _id_map} =
      config.executor.(:transaction, fn tx ->
        {refs, id_map, _i} = process_ops(tx, dialect, table_map, column_maps, enum_type_maps, schema, tree, refs, id_map, 0)

        # Resolve deferred FK updates
        Enum.each(tree.deferred_updates, fn du ->
          real_target_id = Map.get(id_map, du.target_temp_id)
          ref_temp_id = Map.get(tree.aliases, du.ref_alias)
          real_ref_id = if ref_temp_id, do: Map.get(id_map, ref_temp_id)

          unless real_target_id && real_ref_id do
            raise "\"_ref\" \"#{du.ref_alias}\" could not be resolved. Ensure the referenced node has _alias defined in the scenario."
          end

          Create.update_entity(tx, dialect, table_map, column_maps, du.model, real_target_id, %{du.field => real_ref_id}, enum_type_maps)
        end)

        {refs, id_map}
      end, nil)

    scope_value = detect_scope_value(refs, schema["scopeField"]) || test_run_id

    first_user = find_first_user(refs)
    auth = config.auth.(first_user)

    refs_token = Refs.sign(
      %{"refs" => refs, "testRunId" => scope_value, "environment" => ""},
      config.signing_secret
    )

    %{status: 200, body: Map.merge(build_sdk_meta(config), %{"auth" => auth, "refs" => refs, "refsToken" => refs_token})}
  end

  defp process_ops(tx, dialect, table_map, column_maps, enum_type_maps, schema, tree, refs, id_map, i) do
    if i >= length(tree.ops) do
      {refs, id_map, i}
    else
      do_process_op(tx, dialect, table_map, column_maps, enum_type_maps, schema, tree, refs, id_map, i)
    end
  end

  defp do_process_op(tx, dialect, table_map, column_maps, enum_type_maps, schema, tree, refs, id_map, i) do
    op = Enum.at(tree.ops, i)
    model = op.model

    # Collect consecutive ops for the same model with same batch flag
    {batch, i} = collect_batch(tree.ops, i, model, op.batch, [op])

    # Find model info
    model_info = Enum.find(schema["models"], fn m -> m["name"] == model end)

    resolved_fields =
      Enum.map(batch, fn b ->
        fields = Map.delete(b.fields, "id")

        # Replace temp IDs with real IDs
        fields =
          Enum.reduce(fields, %{}, fn {key, value}, acc ->
            resolved =
              if is_binary(value) && String.starts_with?(value, "__temp_") do
                Map.get(id_map, value, value)
              else
                value
              end
            Map.put(acc, key, resolved)
          end)

        # Inject scope field
        fields =
          case Enum.find(schema["edges"], fn e ->
            e["from"] == model &&
              String.downcase(e["localField"]) == String.downcase(schema["scopeField"]) &&
              e["from"] != e["to"]
          end) do
            nil -> fields
            scope_edge ->
              if Map.has_key?(fields, scope_edge["localField"]) do
                fields
              else
                scope_val = detect_scope_value(refs, schema["scopeField"])
                if scope_val, do: Map.put(fields, scope_edge["localField"], scope_val), else: fields
              end
          end

        # Auto-populate required DateTime fields without defaults
        fields =
          if model_info do
            Enum.reduce(model_info["fields"] || [], fields, fn field, acc ->
              if field["isRequired"] && !field["hasDefault"] && !field["isId"] && !Map.has_key?(acc, field["name"]) do
                if field["type"] == "DateTime" do
                  Map.put(acc, field["name"], DateTime.utc_now() |> DateTime.to_iso8601())
                else
                  acc
                end
              else
                acc
              end
            end)
          else
            fields
          end

        fields
      end)

    is_batch = op.batch
    spec = %{model => %{"count" => length(resolved_fields), "fields" => resolved_fields, "batch" => is_batch}}

    created = Create.create_entities(tx, dialect, table_map, column_maps, spec, enum_type_maps)
    records = Map.get(created, model, [])

    refs =
      Map.update(refs, model, records, fn existing -> existing ++ records end)

    id_map =
      batch
      |> Enum.with_index()
      |> Enum.reduce(id_map, fn {b, j}, acc ->
        record = Enum.at(records, j)
        if record do
          record_id = Map.get(record, "id")
          if is_binary(record_id), do: Map.put(acc, b.temp_id, record_id), else: acc
        else
          acc
        end
      end)

    process_ops(tx, dialect, table_map, column_maps, enum_type_maps, schema, tree, refs, id_map, i + 1)
  end

  defp collect_batch(ops, i, model, batch_flag, acc) do
    next = i + 1
    if next < length(ops) do
      next_op = Enum.at(ops, next)
      if next_op.model == model && next_op.batch == batch_flag do
        collect_batch(ops, next, model, batch_flag, acc ++ [next_op])
      else
        {acc, i}
      end
    else
      {acc, i}
    end
  end

  defp handle_down_sql(config, body) do
    refs_token = Map.get(body, "refsToken")
    unless refs_token, do: raise(Error.invalid_body("missing refsToken"))

    payload =
      try do
        Refs.verify!(refs_token, config.signing_secret)
      rescue
        e -> raise Error.invalid_refs_token(Exception.message(e))
      end

    %{schema: schema, table_map: table_map, column_maps: column_maps} = get_introspection(config)
    dialect = get_dialect(config)

    TeardownSQL.teardown(config.executor, dialect, table_map, column_maps, schema, payload["testRunId"], payload["refs"])

    %{status: 200, body: Map.merge(build_sdk_meta(config), %{"ok" => true})}
  end

  # ===========================================================================
  # Legacy adapter path (backward compat)
  # ===========================================================================

  defp handle_discover_legacy(config) do
    {schema, _adapter} = adapter_get_schema(config.adapter)
    %{status: 200, body: Map.merge(build_sdk_meta(config), %{"schema" => schema})}
  end

  defp handle_up_legacy(config, body) do
    create = Map.get(body, "create")
    unless create, do: raise(Error.invalid_body("missing \"create\" in request body"))

    test_run_id = Map.get(body, "testRunId", generate_uuid())

    context = %{"testRunId" => test_run_id, "refs" => %{}}
    {:ok, refs} = adapter_create_entities(config.adapter, create, context)

    refs_token =
      Refs.sign(
        %{"refs" => refs, "testRunId" => test_run_id, "environment" => ""},
        config.signing_secret
      )

    first_user = find_first_user(refs)
    auth = config.auth.(first_user)

    %{status: 200, body: Map.merge(build_sdk_meta(config), %{"auth" => auth, "refs" => refs, "refsToken" => refs_token})}
  end

  defp handle_down_legacy(config, body) do
    refs_token = Map.get(body, "refsToken")
    unless refs_token, do: raise(Error.invalid_body("missing refsToken"))

    payload =
      try do
        Refs.verify!(refs_token, config.signing_secret)
      rescue
        e -> raise Error.invalid_refs_token(Exception.message(e))
      end

    adapter_teardown(config.adapter, payload["testRunId"], payload["refs"])

    %{status: 200, body: Map.merge(build_sdk_meta(config), %{"ok" => true})}
  end

  # ---------------------------------------------------------------------------
  # Legacy adapter dispatch
  # ---------------------------------------------------------------------------

  defp adapter_get_schema(%Autonoma.Ecto.Adapter{} = adapter) do
    Autonoma.Ecto.Adapter.get_schema(adapter)
  end

  defp adapter_get_schema(%{get_schema: fun}) when is_function(fun, 0) do
    {fun.(), nil}
  end

  defp adapter_get_schema(adapter) when is_atom(adapter) do
    {adapter.get_schema(), nil}
  end

  defp adapter_create_entities(%Autonoma.Ecto.Adapter{} = adapter, spec, context) do
    Autonoma.Ecto.Adapter.create_entities(adapter, spec, context)
  end

  defp adapter_create_entities(%{create_entities: fun}, spec, context) when is_function(fun, 2) do
    fun.(spec, context)
  end

  defp adapter_create_entities(adapter, spec, context) when is_atom(adapter) do
    adapter.create_entities(spec, context)
  end

  defp adapter_teardown(%Autonoma.Ecto.Adapter{} = adapter, scope_value, refs) do
    Autonoma.Ecto.Adapter.teardown(adapter, scope_value, refs)
  end

  defp adapter_teardown(%{teardown: fun}, scope_value, refs) when is_function(fun, 2) do
    fun.(scope_value, refs)
  end

  defp adapter_teardown(adapter, scope_value, refs) when is_atom(adapter) do
    adapter.teardown(scope_value, refs)
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp find_first_user(refs) do
    Enum.find_value(refs, fn {model, records} ->
      if String.downcase(model) == "user" && records != [] do
        List.first(records)
      end
    end)
  end

  defp detect_scope_value(refs, scope_field) do
    scope_lower = String.downcase(scope_field)

    Enum.find_value(refs, fn {_model, records} ->
      Enum.find_value(records, fn record ->
        Enum.find_value(record, fn {key, value} ->
          if String.downcase(to_string(key)) == scope_lower && is_binary(value) do
            value
          end
        end)
      end)
    end)
  end

  defp generate_uuid do
    <<a::32, b::16, c::16, d::16, e::48>> = :crypto.strong_rand_bytes(16)

    :io_lib.format("~8.16.0b-~4.16.0b-~4.16.0b-~4.16.0b-~12.16.0b", [a, b, c, d, e])
    |> to_string()
  end
end
