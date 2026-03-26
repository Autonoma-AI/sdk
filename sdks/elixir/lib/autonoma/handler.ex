defmodule Autonoma.Handler do
  @moduledoc """
  Request routing for discover/up/down protocol actions.
  """

  alias Autonoma.{Error, HMAC, Refs}

  @protocol_version "1.0"

  defp build_sdk_meta(config) do
    adapter_name = if is_map(config.adapter) && Map.has_key?(config.adapter, :name), do: config.adapter.name, else: "unknown"
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
    schema = config.adapter.get_schema()
    %{status: 200, body: Map.merge(build_sdk_meta(config), %{"schema" => schema})}
  end

  defp handle_up(config, body) do
    create = Map.get(body, "create")
    unless create, do: raise(Error.invalid_body("missing \"create\" in request body"))

    test_run_id = Map.get(body, "testRunId", generate_uuid())
    schema = config.adapter.get_schema()

    # Create entities via adapter
    spec = %{}
    context = %{"testRunId" => test_run_id, "refs" => %{}}
    {:ok, refs} = config.adapter.create_entities(spec, context)

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

    config.adapter.teardown(payload["testRunId"], payload["refs"])

    %{status: 200, body: Map.merge(build_sdk_meta(config), %{"ok" => true})}
  end

  defp generate_uuid do
    <<a::32, b::16, c::16, d::16, e::48>> = :crypto.strong_rand_bytes(16)

    :io_lib.format("~8.16.0b-~4.16.0b-~4.16.0b-~4.16.0b-~12.16.0b", [a, b, c, d, e])
    |> to_string()
  end
end
