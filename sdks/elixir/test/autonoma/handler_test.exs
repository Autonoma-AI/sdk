defmodule Autonoma.HandlerTest do
  use ExUnit.Case, async: true

  alias Autonoma.{Handler, HMAC, Scenario}

  @shared_secret "test-shared-secret-1234"
  @signing_secret "test-signing-secret-5678"

  defp standard_scenario(down \\ nil) do
    Scenario.define_scenario(
      name: "standard",
      description: "A standard seeded environment",
      up: fn ctx ->
        %{
          auth: %{"headers" => %{"Authorization" => "Bearer #{ctx.test_run_id}"}},
          teardown: %{"userId" => "user-#{ctx.test_run_id}"}
        }
      end,
      down: down
    )
  end

  defp empty_scenario do
    Scenario.define_scenario(
      name: "empty",
      description: "Nothing seeded",
      up: fn _ctx -> %{} end
    )
  end

  defp make_config(overrides \\ %{}) do
    Map.merge(
      %{
        shared_secret: @shared_secret,
        signing_secret: @signing_secret,
        scenarios: [standard_scenario(), empty_scenario()]
      },
      overrides
    )
  end

  defp signed_req(body_map) do
    body = Jason.encode!(body_map)
    %{body: body, headers: %{"x-signature" => HMAC.sign_body(body, @shared_secret)}}
  end

  # --- request gate ---

  test "rejects invalid signature" do
    req = %{body: ~s({"action":"discover"}), headers: %{"x-signature" => "invalid"}}
    result = Handler.handle(make_config(), req)
    assert result.status == 401
    assert result.body["code"] == "INVALID_SIGNATURE"
  end

  test "rejects same secrets" do
    config = %{shared_secret: "same", signing_secret: "same", scenarios: []}
    body = ~s({"action":"discover"})
    req = %{body: body, headers: %{"x-signature" => HMAC.sign_body(body, "same")}}
    result = Handler.handle(config, req)
    assert result.status == 500
    assert result.body["code"] == "SAME_SECRETS"
  end

  test "rejects invalid JSON" do
    raw = "not json"
    req = %{body: raw, headers: %{"x-signature" => HMAC.sign_body(raw, @shared_secret)}}
    result = Handler.handle(make_config(), req)
    assert result.status == 400
    assert result.body["code"] == "INVALID_BODY"
  end

  test "rejects missing action" do
    result = Handler.handle(make_config(), signed_req(%{"foo" => "bar"}))
    assert result.status == 400
    assert result.body["code"] == "INVALID_BODY"
  end

  test "rejects unknown action" do
    result = Handler.handle(make_config(), signed_req(%{"action" => "nonexistent"}))
    assert result.status == 400
    assert result.body["code"] == "UNKNOWN_ACTION"
  end

  # --- discover ---

  test "discover lists registered scenarios" do
    result = Handler.handle(make_config(), signed_req(%{"action" => "discover"}))
    assert result.status == 200
    assert result.body["version"] == "2.0"
    assert result.body["sdk"]["language"] == "elixir"
    assert length(result.body["scenarios"]) == 2
    assert List.first(result.body["scenarios"])["name"] == "standard"
    assert List.first(result.body["scenarios"])["description"] != ""
    # discover must never leak a create/schema shape in v2.
    refute Map.has_key?(result.body, "schema")
  end

  # --- up ---

  test "up returns the envelope" do
    result =
      Handler.handle(
        make_config(),
        signed_req(%{"action" => "up", "scenario" => %{"name" => "standard"}, "testRunId" => "run-1"})
      )

    assert result.status == 200
    assert result.body["version"] == "2.0"
    assert length(String.split(result.body["teardownToken"], ".")) == 3
    assert result.body["expiresInSeconds"] == 3600
    # The duplicated plaintext refs and the old refsToken field are gone.
    refute Map.has_key?(result.body, "refs")
    refute Map.has_key?(result.body, "refsToken")
    assert result.body["auth"]["headers"]["Authorization"] == "Bearer run-1"
  end

  test "up honors a custom expiresInSeconds and omits auth when empty" do
    config = make_config(%{expires_in_seconds: 60})

    result =
      Handler.handle(
        config,
        signed_req(%{"action" => "up", "scenario" => %{"name" => "empty"}, "testRunId" => "r"})
      )

    assert result.status == 200
    assert result.body["expiresInSeconds"] == 60
    refute Map.has_key?(result.body, "auth")
  end

  test "up rejects an unknown environment" do
    result =
      Handler.handle(
        make_config(),
        signed_req(%{"action" => "up", "scenario" => %{"name" => "does-not-exist"}, "testRunId" => "r"})
      )

    assert result.status == 400
    assert result.body["code"] == "UNKNOWN_ENVIRONMENT"
  end

  test "up rejects a missing scenario name" do
    result = Handler.handle(make_config(), signed_req(%{"action" => "up", "testRunId" => "r"}))
    assert result.status == 400
    assert result.body["code"] == "INVALID_BODY"
  end

  test "up accepts a string-keyed result map" do
    string_keyed =
      Scenario.define_scenario(
        name: "string-keyed",
        description: "up returns a string-keyed map",
        up: fn _ctx ->
          %{"auth" => %{"headers" => %{"X-Token" => "plain"}}}
        end
      )

    config = make_config(%{scenarios: [string_keyed]})

    result =
      Handler.handle(
        config,
        signed_req(%{"action" => "up", "scenario" => %{"name" => "string-keyed"}, "testRunId" => "r"})
      )

    assert result.status == 200
    assert result.body["auth"]["headers"]["X-Token"] == "plain"
  end

  test "up defaults testRunId when absent" do
    result =
      Handler.handle(
        make_config(),
        signed_req(%{"action" => "up", "scenario" => %{"name" => "empty"}})
      )

    assert result.status == 200
    assert is_binary(result.body["teardownToken"])
  end

  # --- down ---

  test "down tears a scenario down with a valid teardownToken" do
    test_pid = self()
    down = fn ctx -> send(test_pid, {:down, ctx.name, ctx.test_run_id}) end
    config = make_config(%{scenarios: [standard_scenario(down), empty_scenario()]})

    up =
      Handler.handle(
        config,
        signed_req(%{"action" => "up", "scenario" => %{"name" => "standard"}, "testRunId" => "run-td"})
      )

    token = up.body["teardownToken"]

    down_result =
      Handler.handle(
        config,
        signed_req(%{"action" => "down", "teardownToken" => token, "testRunId" => "run-td"})
      )

    assert down_result.status == 200
    assert down_result.body["ok"] == true
    assert_receive {:down, "standard", "run-td"}
  end

  test "down routes by the token environment, ignoring any request scenario name" do
    test_pid = self()
    down = fn ctx -> send(test_pid, {:down, ctx.name, ctx.test_run_id}) end
    config = make_config(%{scenarios: [standard_scenario(down), empty_scenario()]})

    up =
      Handler.handle(
        config,
        signed_req(%{"action" => "up", "scenario" => %{"name" => "standard"}, "testRunId" => "run-tok"})
      )

    token = up.body["teardownToken"]

    # No scenario.name on the down request - the handler must recover it from
    # the verified token's environment.
    down_result =
      Handler.handle(config, signed_req(%{"action" => "down", "teardownToken" => token}))

    assert down_result.status == 200
    assert_receive {:down, "standard", "run-tok"}
  end

  test "down rejects an invalid teardownToken" do
    result =
      Handler.handle(
        make_config(),
        signed_req(%{"action" => "down", "teardownToken" => "tampered.token.value"})
      )

    assert result.status == 403
    assert result.body["code"] == "INVALID_TEARDOWN_TOKEN"
  end

  test "down rejects a missing teardownToken" do
    result = Handler.handle(make_config(), signed_req(%{"action" => "down"}))
    assert result.status == 400
    assert result.body["code"] == "INVALID_BODY"
  end

  # --- deprecated allow_production ---

  test "endpoint is always enabled and ignores the deprecated allow_production flag" do
    config = make_config(%{allow_production: false})
    result = Handler.handle(config, signed_req(%{"action" => "discover"}))
    assert result.status == 200
    assert length(result.body["scenarios"]) == 2
  end
end
