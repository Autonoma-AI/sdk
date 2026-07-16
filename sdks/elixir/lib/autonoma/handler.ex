defmodule Autonoma.Handler do
  @moduledoc """
  Request routing for discover/up/down protocol actions.

  Factory-driven design: every model in `body.create` must have a
  registered factory. The SDK uses the factory's `input_fields` both
  to validate inputs and to build the `discover` schema. Ordering for
  `up` and `down` comes from the create payload's `_alias` / `_ref`
  graph; there is no SQL introspection.
  """

  alias Autonoma.{Error, HMAC, Refs, PayloadTopo, Schema, Factory}

  @protocol_version_file Path.expand("../../../../protocol/version.txt", __DIR__)
  @external_resource @protocol_version_file
  @protocol_version File.read!(@protocol_version_file) |> String.trim()

  # ---------------------------------------------------------------------------
  # SDK metadata
  # ---------------------------------------------------------------------------

  defp build_sdk_meta(config) do
    sdk = Map.get(config, :sdk, %{})

    orm =
      cond do
        Map.has_key?(sdk, "orm") -> sdk["orm"]
        Map.has_key?(sdk, :orm) -> sdk[:orm]
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

  # ---------------------------------------------------------------------------
  # Main entry point
  # ---------------------------------------------------------------------------

  def handle(config, req) do
    try do
      if config.shared_secret == config.signing_secret do
        raise Error.same_secrets()
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
      unless action, do: raise(Error.invalid_body("missing action. expected one of 'discover', 'up' or 'down'"))

      case action do
        "discover" -> handle_discover(config)
        "up" -> handle_up(config, body)
        "down" -> handle_down(config, body)
        other -> raise Error.unknown_action(other)
      end
    rescue
      e in Error ->
        %{status: e.status, body: %{"error" => e.message, "code" => e.code}}

      e ->
        %{status: 500, body: %{"error" => Exception.message(e), "code" => "INTERNAL_ERROR"}}
    end
  end

  # ---------------------------------------------------------------------------
  # discover
  # ---------------------------------------------------------------------------

  defp handle_discover(config) do
    factories = Map.get(config, :factories) || %{}
    schema = Schema.build_schema_from_factories(factories, config.scope_field)
    %{status: 200, body: Map.merge(build_sdk_meta(config), %{"schema" => Schema.schema_to_wire(schema)})}
  end

  # ---------------------------------------------------------------------------
  # up
  # ---------------------------------------------------------------------------

  defp handle_up(config, body) do
    create = Map.get(body, "create")
    unless create, do: raise(Error.invalid_body("missing \"create\" in request body"))

    test_run_id = Map.get(body, "testRunId", generate_uuid())

    factories = Map.get(config, :factories) || %{}

    if factories == %{} do
      raise Error.invalid_body(
              "no factories registered -- every model in `create` must have a factory."
            )
    end

    tree = PayloadTopo.resolve_payload_tree(create)

    {refs, _id_map} =
      Enum.reduce(tree.ops, {%{}, %{}, %{}}, fn op, {refs, id_map, model_index} ->
        model = op.model
        factory = Map.get(factories, model)

        unless factory do
          raise Error.invalid_body(
                  "no factory registered for model \"#{model}\". " <>
                    "Register one with `define_factory(...)` and add it to config.factories."
                )
        end

        idx = Map.get(model_index, model, 0)
        model_index = Map.put(model_index, model, idx + 1)

        # Substitute built-in tokens then swap temp ids for real ids.
        resolved = resolve_tokens(op.fields, test_run_id, idx)
        resolved = swap_temp_ids(resolved, id_map)

        # Validate through the factory's input_fields
        input_fields = Map.get(factory, :input_fields, [])

        resolved =
          case Factory.validate_input(resolved, input_fields) do
            {:ok, validated} -> validated
            {:error, reason} -> raise Error.invalid_body("#{model}: #{reason}")
          end

        # Call the factory create
        ctx = %{
          refs: refs,
          scenario_name: test_run_id,
          test_run_id: test_run_id
        }

        record = factory.create.(resolved, ctx)

        unless is_map(record) and Map.get(record, "id") != nil do
          raise Error.factory_missing_pk(model, "id")
        end

        refs = Map.update(refs, model, [record], fn existing -> existing ++ [record] end)
        id_map = Map.put(id_map, op.temp_id, record["id"])

        {refs, id_map, model_index}
      end)
      |> then(fn {refs, id_map, _model_index} -> {refs, id_map} end)

    # Auth callback gets the first User (case-insensitive on model name).
    first_user = find_first_user(refs)
    scope_value = detect_scope_value(refs, config.scope_field) || test_run_id
    auth_context = %{"scope_value" => scope_value, "refs" => refs}
    auth = config.auth.(first_user, auth_context)

    auth =
      case Map.get(config, :after_up) do
        nil -> auth
        hook -> hook.(%{scenario_name: scope_value, refs: refs}, auth)
      end

    refs_token =
      Refs.sign(
        %{
          "refs" => refs,
          "testRunId" => scope_value,
          "environment" => "",
          "aliasDependencies" => tree.alias_dependencies,
          "aliasOwnerModel" => tree.alias_owner_model
        },
        config.signing_secret
      )

    %{
      status: 200,
      body:
        Map.merge(build_sdk_meta(config), %{
          "auth" => auth,
          "refs" => refs,
          "refsToken" => refs_token
        })
    }
  end

  # ---------------------------------------------------------------------------
  # down
  # ---------------------------------------------------------------------------

  defp handle_down(config, body) do
    refs_token = Map.get(body, "refsToken")
    unless refs_token, do: raise(Error.invalid_body("missing refsToken"))

    payload =
      try do
        Refs.verify!(refs_token, config.signing_secret)
      rescue
        e -> raise Error.invalid_refs_token(Exception.message(e))
      end

    refs = Map.get(payload, "refs") || %{}
    test_run_id = Map.get(payload, "testRunId", "")
    alias_deps = Map.get(payload, "aliasDependencies") || %{}
    alias_owner_model = Map.get(payload, "aliasOwnerModel") || %{}

    case Map.get(config, :before_down) do
      nil -> :ok
      hook -> hook.(%{scenario_name: test_run_id, refs: refs})
    end

    factories = Map.get(config, :factories) || %{}
    teardown_order = PayloadTopo.compute_teardown_order(refs, alias_deps, alias_owner_model)

    Enum.each(teardown_order, fn model ->
      factory = Map.get(factories, model)

      if factory != nil and factory.teardown != nil do
        records = Map.get(refs, model, [])

        ctx = %{
          refs: refs,
          scenario_name: test_run_id,
          test_run_id: test_run_id
        }

        records
        |> Enum.reverse()
        |> Enum.each(fn record ->
          factory.teardown.(record, ctx)
        end)
      end
    end)

    %{status: 200, body: Map.merge(build_sdk_meta(config), %{"ok" => true})}
  end

  # ---------------------------------------------------------------------------
  # Token resolution (defense-in-depth)
  # ---------------------------------------------------------------------------

  @token_re ~r/\{\{\s*([^{}]+?)\s*\}\}/
  @cycle_re ~r/^cycle\((.*)\)$/

  @doc """
  Substitute built-in tokens in field values: {{testRunId}}, {{index}},
  {{cycle(a,b,c)}}. Raises Autonoma.Error with code `UNRESOLVED_TOKEN` for any
  other `{{token}}` that reaches the SDK.
  """
  def resolve_tokens(value, test_run_id, index) when is_binary(value) do
    Regex.replace(@token_re, value, fn _full, token ->
      token = String.trim(token)

      cond do
        token == "testRunId" ->
          test_run_id

        token == "index" ->
          Integer.to_string(index)

        match = Regex.run(@cycle_re, token) ->
          [_, inner] = match

          parts =
            inner
            |> String.split(",")
            |> Enum.map(fn p ->
              p
              |> String.trim()
              |> String.trim(~s("))
              |> String.trim(~s('))
            end)

          case parts do
            [] -> ""
            _ -> Enum.at(parts, rem(index, length(parts)))
          end

        true ->
          raise %Autonoma.Error{
            message: "Unresolved token: {{#{token}}}",
            code: "UNRESOLVED_TOKEN",
            status: 400
          }
      end
    end)
  end

  def resolve_tokens(value, test_run_id, index) when is_list(value) do
    Enum.map(value, &resolve_tokens(&1, test_run_id, index))
  end

  def resolve_tokens(value, test_run_id, index) when is_map(value) do
    Enum.reduce(value, %{}, fn {k, v}, acc ->
      Map.put(acc, k, resolve_tokens(v, test_run_id, index))
    end)
  end

  def resolve_tokens(value, _test_run_id, _index), do: value

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  @doc false
  def swap_temp_ids(value, id_map) when is_binary(value) do
    if String.starts_with?(value, "__temp_") do
      Map.get(id_map, value, value)
    else
      value
    end
  end

  def swap_temp_ids(value, id_map) when is_map(value) do
    Map.new(value, fn {k, v} -> {k, swap_temp_ids(v, id_map)} end)
  end

  def swap_temp_ids(value, id_map) when is_list(value) do
    Enum.map(value, fn v -> swap_temp_ids(v, id_map) end)
  end

  def swap_temp_ids(value, _id_map), do: value

  defp find_first_user(refs) do
    Enum.find_value(refs, fn {model, records} ->
      normalized = String.downcase(model)

      if (normalized == "user" or normalized == "users") and records != [] do
        List.first(records)
      end
    end)
  end

  defp normalize_field(name), do: name |> String.replace("_", "") |> String.downcase()

  defp detect_scope_value(refs, scope_field) do
    scope_normalized = normalize_field(scope_field)

    Enum.find_value(refs, fn {_model, records} ->
      Enum.find_value(records, fn record ->
        Enum.find_value(record, fn {key, value} ->
          if normalize_field(to_string(key)) == scope_normalized and is_binary(value) do
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
