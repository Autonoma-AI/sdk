defmodule Autonoma.Handler do
  @moduledoc """
  Request routing for discover / up / down protocol actions (Scenario v2).

  `discover` lists the registered scenarios; `up` looks a scenario up by name,
  runs its free-form `up`, signs a teardown token carrying the scenario name,
  and responds; `down` recovers the scenario name from the verified token and
  routes to that scenario's `down`. There is no create-graph interpreter and no
  factory-derived discover schema.
  """

  alias Autonoma.{Error, HMAC, Refs}

  @protocol_version_file Path.expand("../../../../protocol/version.txt", __DIR__)
  @external_resource @protocol_version_file
  @protocol_version File.read!(@protocol_version_file) |> String.trim()

  @default_expires_in_seconds 3600

  # ---------------------------------------------------------------------------
  # Main entry point
  # ---------------------------------------------------------------------------

  def handle(config, req) do
    try do
      warn_deprecated_allow_production(config)

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
          {:ok, parsed} when is_map(parsed) -> parsed
          _ -> raise Error.invalid_body("invalid JSON")
        end

      action = Map.get(body, "action")

      unless is_binary(action) and action != "" do
        raise Error.invalid_body(~s(missing action. expected one of "discover", "up" or "down"))
      end

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
    scenarios =
      config
      |> scenarios_of()
      |> Enum.map(fn s -> %{"name" => s.name, "description" => s.description} end)

    %{status: 200, body: Map.merge(build_sdk_meta(config), %{"scenarios" => scenarios})}
  end

  # ---------------------------------------------------------------------------
  # up
  # ---------------------------------------------------------------------------

  defp handle_up(config, body) do
    name = read_scenario_name(body)

    unless is_binary(name) and name != "" do
      raise Error.invalid_body(~s(missing "scenario.name" in request body))
    end

    scenario = find_scenario(config, name)
    unless scenario, do: raise(Error.unknown_environment(name))

    test_run_id =
      case Map.get(body, "testRunId") do
        id when is_binary(id) and id != "" -> id
        _ -> generate_uuid()
      end

    result = scenario.up.(%{test_run_id: test_run_id}) || %{}
    {auth, teardown} = read_up_result(result)

    teardown_token =
      Refs.sign(
        %{"refs" => teardown || %{}, "testRunId" => test_run_id, "environment" => name},
        config.signing_secret
      )

    expires_in_seconds = Map.get(config, :expires_in_seconds) || @default_expires_in_seconds

    response_body =
      config
      |> build_sdk_meta()
      |> maybe_put("auth", auth)
      |> Map.put("teardownToken", teardown_token)
      |> Map.put("expiresInSeconds", expires_in_seconds)

    %{status: 200, body: response_body}
  end

  # ---------------------------------------------------------------------------
  # down
  # ---------------------------------------------------------------------------

  defp handle_down(config, body) do
    teardown_token = Map.get(body, "teardownToken")

    unless is_binary(teardown_token) and teardown_token != "" do
      raise Error.invalid_body("missing teardownToken")
    end

    payload =
      try do
        Refs.verify!(teardown_token, config.signing_secret)
      rescue
        e -> raise Error.invalid_teardown_token(Exception.message(e))
      end

    teardown =
      case Map.get(payload, "refs") do
        m when is_map(m) -> m
        _ -> %{}
      end

    test_run_id =
      case Map.get(payload, "testRunId") do
        id when is_binary(id) -> id
        _ -> ""
      end

    # The verified token is authoritative for routing; any scenario name on the
    # request body is ignored.
    name =
      case Map.get(payload, "environment") do
        n when is_binary(n) -> n
        _ -> ""
      end

    if name != "" do
      scenario = find_scenario(config, name)

      if scenario != nil and scenario.down != nil do
        scenario.down.(%{name: name, teardown: teardown, test_run_id: test_run_id})
      end
    end

    %{status: 200, body: Map.merge(build_sdk_meta(config), %{"ok" => true})}
  end

  # ---------------------------------------------------------------------------
  # SDK metadata
  # ---------------------------------------------------------------------------

  defp build_sdk_meta(config) do
    sdk = Map.get(config, :sdk) || %{}

    %{
      "version" => @protocol_version,
      "sdk" => %{
        "language" => "elixir",
        "orm" => sdk_field(sdk, "orm", :orm, "unknown"),
        "server" => sdk_field(sdk, "server", :server, "unknown")
      }
    }
  end

  defp sdk_field(sdk, string_key, atom_key, default) do
    cond do
      Map.has_key?(sdk, string_key) -> Map.get(sdk, string_key)
      Map.has_key?(sdk, atom_key) -> Map.get(sdk, atom_key)
      true -> default
    end
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  # One-shot runtime signal - the config-key deprecation is invisible at runtime
  # otherwise. :persistent_term keeps it to one warning per VM.
  defp warn_deprecated_allow_production(config) do
    if Map.get(config, :allow_production, false) and
         not :persistent_term.get({__MODULE__, :warned_allow_production}, false) do
      :persistent_term.put({__MODULE__, :warned_allow_production}, true)
      IO.warn("allow_production is deprecated and ignored - the endpoint is always enabled")
    end

    :ok
  end

  defp scenarios_of(config), do: Map.get(config, :scenarios) || []

  defp find_scenario(config, name) do
    config
    |> scenarios_of()
    |> Enum.find(fn s -> s.name == name end)
  end

  # Read `body.scenario.name` from an untrusted JSON body.
  defp read_scenario_name(body) do
    case Map.get(body, "scenario") do
      scenario when is_map(scenario) ->
        case Map.get(scenario, "name") do
          name when is_binary(name) -> name
          _ -> nil
        end

      _ ->
        nil
    end
  end

  # Normalize a scenario up return into {auth, teardown}. Accepts a map
  # keyed by either atoms or strings so both `%{auth: ...}` and `%{"auth" => ...}`
  # results work.
  defp read_up_result(result) when is_map(result) do
    {get_either(result, :auth, "auth"), get_either(result, :teardown, "teardown")}
  end

  defp read_up_result(_), do: {nil, nil}

  defp get_either(map, atom_key, string_key) do
    case Map.fetch(map, atom_key) do
      {:ok, value} -> value
      :error -> Map.get(map, string_key)
    end
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp generate_uuid do
    <<a::32, b::16, c::16, d::16, e::48>> = :crypto.strong_rand_bytes(16)

    :io_lib.format("~8.16.0b-~4.16.0b-~4.16.0b-~4.16.0b-~12.16.0b", [a, b, c, d, e])
    |> to_string()
  end
end
