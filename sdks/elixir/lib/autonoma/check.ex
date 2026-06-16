defmodule Autonoma.Check do
  @moduledoc "Dry-run a scenario against factories (up -> down cycle)."

  alias Autonoma.{HMAC, Handler}

  defmodule CheckError do
    @moduledoc false
    defstruct [:phase, :message, :fix]
  end

  defmodule CheckResult do
    @moduledoc false
    defstruct valid: false, phase: "ok", errors: [], timing: nil
  end

  def check_scenario(scenario, opts \\ []) do
    shared_secret = Keyword.get(opts, :shared_secret, "autonoma-check-shared")
    signing_secret = Keyword.get(opts, :signing_secret, "autonoma-check-signing")

    config = %{
      scope_field: Keyword.get(opts, :scope_field, "organizationId"),
      shared_secret: shared_secret,
      signing_secret: signing_secret,
      allow_production: Keyword.get(opts, :allow_production, true),
      sdk: Keyword.get(opts, :sdk, %{}),
      factories: Keyword.get(opts, :factories, %{}),
      auth:
        Keyword.get(opts, :auth, fn _user, _ctx ->
          %{"headers" => %{"Authorization" => "Bearer check-token"}}
        end)
    }

    create = Map.get(scenario, "create", Map.get(scenario, :create, %{}))

    # Up
    up_body = Jason.encode!(%{"action" => "up", "create" => create})
    up_sig = HMAC.sign_body(up_body, shared_secret)

    t0 = System.monotonic_time(:millisecond)
    up_res = Handler.handle(config, %{body: up_body, headers: %{"x-signature" => up_sig}})
    up_ms = System.monotonic_time(:millisecond) - t0

    if up_res.status != 200 do
      error_msg = Map.get(up_res.body, "error", "Unknown error")

      %CheckResult{
        valid: false,
        phase: "up",
        errors: [%CheckError{phase: "up", message: error_msg, fix: suggest_fix(error_msg)}],
        timing: %{up_ms: up_ms, down_ms: 0}
      }
    else
      refs_token = Map.get(up_res.body, "refsToken")

      # Down
      down_body = Jason.encode!(%{"action" => "down", "refsToken" => refs_token})
      down_sig = HMAC.sign_body(down_body, shared_secret)

      t1 = System.monotonic_time(:millisecond)
      down_res = Handler.handle(config, %{body: down_body, headers: %{"x-signature" => down_sig}})
      down_ms = System.monotonic_time(:millisecond) - t1

      if down_res.status != 200 do
        error_msg = Map.get(down_res.body, "error", "Unknown error")

        %CheckResult{
          valid: false,
          phase: "down",
          errors: [%CheckError{phase: "down", message: error_msg}],
          timing: %{up_ms: up_ms, down_ms: down_ms}
        }
      else
        %CheckResult{
          valid: true,
          phase: "ok",
          errors: [],
          timing: %{up_ms: up_ms, down_ms: down_ms}
        }
      end
    end
  end

  def check_all_scenarios(scenarios, opts \\ []) do
    Enum.map(scenarios, fn scenario ->
      check_scenario(scenario, opts)
    end)
  end

  defp suggest_fix(msg) do
    cond do
      String.contains?(msg, "missing required fields") ->
        "A required field is missing. Add it to the entity with a value."

      String.contains?(msg, "no factory registered") ->
        "Register a factory for the referenced model."

      String.contains?(msg, "cycle detected") ->
        "Break the circular dependency between models."

      true ->
        nil
    end
  end
end
