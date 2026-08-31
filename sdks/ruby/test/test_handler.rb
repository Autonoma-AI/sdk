# frozen_string_literal: true

require "minitest/autorun"
require "json"
require_relative "../lib/autonoma"

class TestHandler < Minitest::Test
  def setup
    @down_calls = []
    @config = base_config
  end

  # Registers the standard + empty scenarios. `down` records name:testRunId so
  # tests can assert routing.
  def scenarios(down_calls)
    [
      Autonoma::Scenario.define_scenario(
        name: "standard",
        description: "A standard seeded environment",
        up: ->(ctx) {
          {
            auth: { "headers" => { "Authorization" => "Bearer #{ctx.test_run_id}" } },
            teardown: { "userId" => "user-#{ctx.test_run_id}" }
          }
        },
        down: ->(ctx) { down_calls << "#{ctx.name}:#{ctx.test_run_id}" }
      ),
      Autonoma::Scenario.define_scenario(
        name: "empty",
        description: "Nothing seeded",
        up: ->(_ctx) { {} }
      )
    ]
  end

  def base_config(**overrides)
    defaults = {
      shared_secret: "shared",
      signing_secret: "signing",
      scenarios: scenarios(@down_calls)
    }
    Autonoma::HandlerConfig.new(**defaults.merge(overrides))
  end

  def signed_request(body, secret = "shared")
    body_str = body.is_a?(String) ? body : JSON.generate(body)
    Autonoma::HandlerRequest.new(
      body: body_str,
      headers: { "x-signature" => Autonoma::Hmac.sign_body(body_str, secret) }
    )
  end

  # --- request gate ---

  def test_rejects_invalid_signature
    req = Autonoma::HandlerRequest.new(
      body: '{"action":"discover"}',
      headers: { "x-signature" => "invalid" }
    )
    result = Autonoma::Handler.handle_request(@config, req)
    assert_equal 401, result.status
    assert_equal "INVALID_SIGNATURE", result.body["code"]
  end

  def test_rejects_same_secrets
    bad = Autonoma::HandlerConfig.new(
      shared_secret: "same", signing_secret: "same", scenarios: []
    )
    result = Autonoma::Handler.handle_request(bad, signed_request({ "action" => "discover" }, "same"))
    assert_equal 500, result.status
    assert_equal "SAME_SECRETS", result.body["code"]
  end

  def test_rejects_invalid_json
    result = Autonoma::Handler.handle_request(@config, signed_request("not json"))
    assert_equal 400, result.status
    assert_equal "INVALID_BODY", result.body["code"]
  end

  def test_rejects_missing_action
    result = Autonoma::Handler.handle_request(@config, signed_request({ "foo" => "bar" }))
    assert_equal 400, result.status
    assert_equal "INVALID_BODY", result.body["code"]
  end

  def test_rejects_unknown_action
    result = Autonoma::Handler.handle_request(@config, signed_request({ "action" => "nonexistent" }))
    assert_equal 400, result.status
    assert_equal "UNKNOWN_ACTION", result.body["code"]
  end

  def test_serves_even_when_allow_production_is_false
    ungated = base_config(allow_production: false)
    result = Autonoma::Handler.handle_request(ungated, signed_request({ "action" => "discover" }))
    assert_equal 200, result.status
  end

  # --- discover ---

  def test_discover_lists_scenarios
    result = Autonoma::Handler.handle_request(@config, signed_request({ "action" => "discover" }))
    assert_equal 200, result.status
    assert_equal "2.0", result.body["version"]
    assert_equal "ruby", result.body["sdk"]["language"]

    scenarios = result.body["scenarios"]
    assert_kind_of Array, scenarios
    assert_equal 2, scenarios.length
    assert_equal "standard", scenarios[0]["name"]
    refute_empty scenarios[0]["description"]

    # discover must never leak a create/schema shape in v2.
    refute result.body.key?("schema")
  end

  # --- up ---

  def test_up_returns_envelope
    body = { "action" => "up", "scenario" => { "name" => "standard" }, "testRunId" => "run-1" }
    result = Autonoma::Handler.handle_request(@config, signed_request(body))

    assert_equal 200, result.status
    assert_equal "2.0", result.body["version"]
    assert_equal 3, result.body["teardownToken"].split(".").length
    assert_equal 3600, result.body["expiresInSeconds"]
    assert_equal "Bearer run-1", result.body["auth"]["headers"]["Authorization"]
    # The duplicated plaintext refs and the old refsToken field are gone.
    refute result.body.key?("refs")
    refute result.body.key?("refsToken")
  end

  def test_up_custom_expires
    config = base_config(expires_in_seconds: 60)
    body = { "action" => "up", "scenario" => { "name" => "empty" }, "testRunId" => "r" }
    result = Autonoma::Handler.handle_request(config, signed_request(body))
    assert_equal 60, result.body["expiresInSeconds"]
    # The empty scenario returns nothing: no auth on the envelope.
    refute result.body.key?("auth")
  end

  def test_up_unknown_environment
    body = { "action" => "up", "scenario" => { "name" => "does-not-exist" }, "testRunId" => "r" }
    result = Autonoma::Handler.handle_request(@config, signed_request(body))
    assert_equal 400, result.status
    assert_equal "UNKNOWN_ENVIRONMENT", result.body["code"]
  end

  def test_up_missing_scenario_name
    body = { "action" => "up", "testRunId" => "r" }
    result = Autonoma::Handler.handle_request(@config, signed_request(body))
    assert_equal 400, result.status
    assert_equal "INVALID_BODY", result.body["code"]
  end

  # --- down ---

  def test_down_valid_token
    up_body = { "action" => "up", "scenario" => { "name" => "standard" }, "testRunId" => "run-td" }
    token = Autonoma::Handler.handle_request(@config, signed_request(up_body)).body["teardownToken"]

    down_body = { "action" => "down", "teardownToken" => token, "testRunId" => "run-td" }
    result = Autonoma::Handler.handle_request(@config, signed_request(down_body))

    assert_equal 200, result.status
    assert_equal true, result.body["ok"]
    assert_equal ["standard:run-td"], @down_calls
  end

  def test_down_routes_by_token_environment
    up_body = { "action" => "up", "scenario" => { "name" => "standard" }, "testRunId" => "run-tok" }
    token = Autonoma::Handler.handle_request(@config, signed_request(up_body)).body["teardownToken"]

    # No scenario.name on the down request: recovered from the token environment.
    down_body = { "action" => "down", "teardownToken" => token }
    result = Autonoma::Handler.handle_request(@config, signed_request(down_body))

    assert_equal 200, result.status
    assert_equal ["standard:run-tok"], @down_calls
  end

  def test_down_invalid_teardown_token
    body = { "action" => "down", "teardownToken" => "tampered.token.value" }
    result = Autonoma::Handler.handle_request(@config, signed_request(body))
    assert_equal 403, result.status
    assert_equal "INVALID_TEARDOWN_TOKEN", result.body["code"]
  end

  def test_down_missing_teardown_token
    result = Autonoma::Handler.handle_request(@config, signed_request({ "action" => "down" }))
    assert_equal 400, result.status
    assert_equal "INVALID_BODY", result.body["code"]
  end
end
