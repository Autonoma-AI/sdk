defmodule Autonoma.Handler do
  @moduledoc """
  Request routing for discover/up/down protocol actions.
  """

  alias Autonoma.{Error, HMAC, Refs}

  @protocol_version "1.0"

  defp build_sdk_meta(config) do
    adapter_name = get_adapter_name(config.adapter)
    server_name = Map.get(config, :sdk_server, "unknown")
    %{
      "version" => @protocol_version,
      "sdk" => %{
        "language" => "elixir",
        "orm" => adapter_name,
        "server" => server_name
      }
    }
  end

  defp get_adapter_name(%Autonoma.Ecto.Adapter{}), do: "ecto"
  defp get_adapter_name(%{name: name}), do: name
  defp get_adapter_name(_), do: "unknown"

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

  defp handle_discover(config) do
    {schema, _adapter} = adapter_get_schema(config.adapter)
    %{status: 200, body: Map.merge(build_sdk_meta(config), %{"schema" => schema})}
  end

  defp handle_up(config, body) do
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

    auth =
      if config[:auth] do
        config.auth.(%{})
      else
        %{"token" => ""}
      end

    %{status: 200, body: Map.merge(build_sdk_meta(config), %{"auth" => auth, "refs" => refs, "refsToken" => refs_token})}
  end

  defp handle_down(config, body) do
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
  # Adapter dispatch — supports Ecto.Adapter structs and plain maps/modules
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

  defp generate_uuid do
    <<a::32, b::16, c::16, d::16, e::48>> = :crypto.strong_rand_bytes(16)

    :io_lib.format("~8.16.0b-~4.16.0b-~4.16.0b-~4.16.0b-~12.16.0b", [a, b, c, d, e])
    |> to_string()
  end
end
