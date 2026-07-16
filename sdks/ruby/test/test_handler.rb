# frozen_string_literal: true

require "minitest/autorun"
require "json"
require "securerandom"
require_relative "../lib/autonoma"

class TestHandler < Minitest::Test
  def setup
    @user_factory = Autonoma::Factory.define_factory(
      create: ->(data, _ctx) {
        { "id" => "user-#{SecureRandom.hex(4)}", "name" => data["name"], "email" => data["email"] }
      },
      input_fields: [
        { name: "name", type: "string", required: true },
        { name: "email", type: "string", required: true }
      ]
    )

    @config = Autonoma::HandlerConfig.new(
      scope_field: "organizationId",
      shared_secret: "shared-secret",
      signing_secret: "signing-secret",
      auth: ->(user, _ctx) { { "headers" => { "Authorization" => "Bearer test-token-#{user ? user['id'] : 'anon'}" } } },
      factories: { "Users" => @user_factory }
    )
  end

  def make_request(body, secret = "shared-secret")
    body_str = body.is_a?(String) ? body : JSON.generate(body)
    sig = Autonoma::Hmac.sign_body(body_str, secret)
    Autonoma::HandlerRequest.new(
      body: body_str,
      headers: { "x-signature" => sig }
    )
  end

  def test_rejects_same_secrets
    bad_config = Autonoma::HandlerConfig.new(
      scope_field: "organizationId",
      shared_secret: "same-secret",
      signing_secret: "same-secret",
      auth: ->(user, _ctx) { { "headers" => {} } },
      factories: { "Users" => @user_factory }
    )
    req = make_request({ "action" => "discover" }, "same-secret")
    result = Autonoma::Handler.handle_request(bad_config, req)
    assert_equal 500, result.status
    assert_equal "SAME_SECRETS", result.body["code"]
  end

  def test_rejects_invalid_signature
    req = Autonoma::HandlerRequest.new(
      body: '{"action":"discover"}',
      headers: { "x-signature" => "bad-signature-value-that-is-exactly-64-chars-long-padding-here!!" }
    )
    result = Autonoma::Handler.handle_request(@config, req)
    assert_equal 401, result.status
    assert_equal "INVALID_SIGNATURE", result.body["code"]
  end

  def test_rejects_invalid_json
    req = make_request("not json")
    result = Autonoma::Handler.handle_request(@config, req)
    assert_equal 400, result.status
    assert_equal "INVALID_BODY", result.body["code"]
  end

  def test_rejects_missing_action
    req = make_request({ "foo" => "bar" })
    result = Autonoma::Handler.handle_request(@config, req)
    assert_equal 400, result.status
    assert_equal "INVALID_BODY", result.body["code"]
  end

  def test_rejects_unknown_action
    req = make_request({ "action" => "unknown" })
    result = Autonoma::Handler.handle_request(@config, req)
    assert_equal 400, result.status
    assert_equal "UNKNOWN_ACTION", result.body["code"]
  end

  def test_serves_even_when_allow_production_is_false
    # allow_production is a deprecated no-op: even an explicit false must not
    # block the endpoint. HMAC signing is the gate. (@config leaves it unset.)
    ungated_config = Autonoma::HandlerConfig.new(
      scope_field: "organizationId",
      shared_secret: "shared-secret",
      signing_secret: "signing-secret",
      auth: ->(_user, _ctx) { { "headers" => {} } },
      allow_production: false,
      factories: { "Users" => @user_factory }
    )
    req = make_request({ "action" => "discover" })
    result = Autonoma::Handler.handle_request(ungated_config, req)
    assert_equal 200, result.status
  end

  def test_discover_returns_sdk_meta_with_ruby
    req = make_request({ "action" => "discover" })
    result = Autonoma::Handler.handle_request(@config, req)

    assert_equal 200, result.status
    assert_equal "ruby", result.body["sdk"]["language"]
    assert_equal "unknown", result.body["sdk"]["orm"]
    assert_equal "unknown", result.body["sdk"]["server"]
  end

  def test_discover_returns_schema
    req = make_request({ "action" => "discover" })
    result = Autonoma::Handler.handle_request(@config, req)

    assert_equal 200, result.status
    schema = result.body["schema"]
    refute_nil schema
    assert_kind_of Array, schema["models"]
    assert_equal 1, schema["models"].length
    assert_equal "Users", schema["models"][0]["name"]
    assert_equal "organizationId", schema["scopeField"]
    assert_equal [], schema["edges"]
    assert_equal [], schema["relations"]
  end

  def test_after_up_hook_modifies_auth
    org_factory = Autonoma::Factory.define_factory(
      create: ->(data, _ctx) { { "id" => "org-1", "name" => data["name"] } },
      input_fields: [{ name: "name", type: "string", required: true }]
    )
    user_factory = Autonoma::Factory.define_factory(
      create: ->(data, _ctx) { { "id" => "user-1", "name" => data["name"], "email" => data["email"] } },
      input_fields: [
        { name: "name", type: "string", required: true },
        { name: "email", type: "string", required: true }
      ]
    )

    config = Autonoma::HandlerConfig.new(
      scope_field: "organizationId",
      shared_secret: "shared-secret",
      signing_secret: "signing-secret",
      auth: ->(_user, _context) { { "headers" => { "Authorization" => "Bearer test-token" } } },
      after_up: ->(hook_ctx, auth) {
        auth["headers"]["X-Custom"] = "enriched"
        auth
      },
      factories: { "Users" => user_factory }
    )

    req = make_request({
      "action" => "up",
      "create" => { "Users" => [{ "name" => "Test", "email" => "test@test.com" }] },
      "testRunId" => "run-1"
    })
    result = Autonoma::Handler.handle_request(config, req)

    assert_equal 200, result.status
    assert_equal "enriched", result.body["auth"]["headers"]["X-Custom"]
  end

  def test_before_down_hook_is_called
    hook_called = false
    captured_ctx = nil

    user_factory = Autonoma::Factory.define_factory(
      create: ->(data, _ctx) { { "id" => "u1", "name" => data["name"], "email" => data["email"] } },
      input_fields: [
        { name: "name", type: "string", required: true },
        { name: "email", type: "string", required: true }
      ]
    )

    config = Autonoma::HandlerConfig.new(
      scope_field: "organizationId",
      shared_secret: "shared-secret",
      signing_secret: "signing-secret",
      auth: ->(_user, _context) { { "headers" => {} } },
      before_down: ->(hook_ctx) {
        hook_called = true
        captured_ctx = hook_ctx
      },
      factories: { "Users" => user_factory }
    )

    refs_token = Autonoma::Refs.sign_refs(
      { "refs" => { "Users" => [{ "id" => "u1" }] }, "testRunId" => "run-1", "environment" => "" },
      "signing-secret"
    )

    req = make_request({ "action" => "down", "refsToken" => refs_token })
    result = Autonoma::Handler.handle_request(config, req)

    assert_equal 200, result.status
    assert hook_called, "before_down hook should have been called"
    assert_equal "run-1", captured_ctx.scenario_name
  end
end

class TestFactories < Minitest::Test
  def make_factory_config(**overrides)
    defaults = {
      scope_field: "organizationId",
      shared_secret: "test-secret",
      signing_secret: "test-signing-secret",
      auth: ->(_user, _ctx) { { "headers" => { "Authorization" => "Bearer token" } } },
      factories: {}
    }
    defaults.merge!(overrides)
    Autonoma::HandlerConfig.new(**defaults)
  end

  def make_request(body, secret = "test-secret")
    body_str = body.is_a?(String) ? body : JSON.generate(body)
    sig = Autonoma::Hmac.sign_body(body_str, secret)
    Autonoma::HandlerRequest.new(
      body: body_str,
      headers: { "x-signature" => sig }
    )
  end

  def test_factory_create_instead_of_sql
    calls = []

    org_create = ->(data, _ctx) {
      calls << data
      { "id" => "factory-org-1", "name" => data["name"] }
    }
    org_factory = Autonoma::Factory.define_factory(
      create: org_create,
      input_fields: [{ name: "name", type: "string", required: true }]
    )

    config = make_factory_config(
      factories: { "Organization" => org_factory }
    )
    req = make_request(
      { "action" => "up", "create" => { "Organization" => [{ "name" => "FactoryOrg" }] }, "testRunId" => "run-1" }
    )
    result = Autonoma::Handler.handle_request(config, req)

    assert_equal 200, result.status
    assert_equal 1, calls.length
    assert_equal "FactoryOrg", calls[0]["name"]
    assert_equal "factory-org-1", result.body["refs"]["Organization"][0]["id"]
  end

  def test_factory_receives_resolved_fk_ids
    received = {}

    org_factory = Autonoma::Factory.define_factory(
      create: ->(data, _ctx) { { "id" => "resolved-org-id", "name" => data["name"] } },
      input_fields: [{ name: "name", type: "string", required: true }]
    )

    user_factory = Autonoma::Factory.define_factory(
      create: ->(data, _ctx) {
        received.merge!(data)
        { "id" => "user-1", "email" => data["email"], "organizationId" => data["organizationId"] }
      },
      input_fields: [
        { name: "email", type: "string", required: true },
        { name: "name", type: "string", required: true },
        { name: "organizationId", type: "string", required: false }
      ]
    )

    config = make_factory_config(
      factories: {
        "Organization" => org_factory,
        "User" => user_factory
      }
    )
    req = make_request(
      {
        "action" => "up",
        "create" => {
          "Organization" => [{ "_alias" => "org1", "name" => "Org" }],
          "User" => [{ "email" => "a@b.com", "name" => "A", "organizationId" => { "_ref" => "org1" } }]
        },
        "testRunId" => "run-3"
      }
    )
    result = Autonoma::Handler.handle_request(config, req)

    assert_equal 200, result.status
    assert_equal "resolved-org-id", received["organizationId"]
  end

  def test_factory_missing_pk_error
    org_factory = Autonoma::Factory.define_factory(
      create: ->(data, _ctx) { { "name" => data["name"] } }, # missing 'id'
      input_fields: [{ name: "name", type: "string", required: true }]
    )

    config = make_factory_config(
      factories: { "Organization" => org_factory }
    )
    req = make_request(
      { "action" => "up", "create" => { "Organization" => [{ "name" => "NoPK" }] }, "testRunId" => "run-4" }
    )
    result = Autonoma::Handler.handle_request(config, req)

    assert_equal 500, result.status
    assert_equal "FACTORY_MISSING_PK", result.body["code"]
  end

  def test_factory_teardown_called_per_record
    teardown_calls = []

    org_factory = Autonoma::Factory.define_factory(
      create: ->(data, _ctx) { { "id" => "org-#{data['name']}", "name" => data["name"] } },
      input_fields: [{ name: "name", type: "string", required: true }],
      teardown: ->(record, _ctx) { teardown_calls << record["id"] }
    )

    config = make_factory_config(
      factories: { "Organization" => org_factory }
    )

    # Create
    up_req = make_request(
      { "action" => "up", "create" => { "Organization" => [{ "name" => "A" }, { "name" => "B" }] }, "testRunId" => "run-5" }
    )
    up_res = Autonoma::Handler.handle_request(config, up_req)
    assert_equal 200, up_res.status
    refs_token = up_res.body["refsToken"]

    # Teardown
    down_req = make_request({ "action" => "down", "refsToken" => refs_token })
    down_res = Autonoma::Handler.handle_request(config, down_req)

    assert_equal 200, down_res.status
    assert_equal 2, teardown_calls.length
    assert_equal ["org-B", "org-A"], teardown_calls # reverse order
  end

  def test_no_teardown_skips_gracefully
    org_factory = Autonoma::Factory.define_factory(
      create: ->(data, _ctx) { { "id" => "org-1", "name" => data["name"] } },
      input_fields: [{ name: "name", type: "string", required: true }]
      # no teardown
    )

    config = make_factory_config(
      factories: { "Organization" => org_factory }
    )

    up_req = make_request(
      { "action" => "up", "create" => { "Organization" => [{ "name" => "Org" }] }, "testRunId" => "run-6" }
    )
    up_res = Autonoma::Handler.handle_request(config, up_req)
    assert_equal 200, up_res.status

    down_req = make_request({ "action" => "down", "refsToken" => up_res.body["refsToken"] })
    down_res = Autonoma::Handler.handle_request(config, down_req)

    assert_equal 200, down_res.status
    assert_equal true, down_res.body["ok"]
  end

  def test_factory_context_has_refs
    captured_ctx = {}

    org_factory = Autonoma::Factory.define_factory(
      create: ->(data, _ctx) { { "id" => "org-ctx", "name" => data["name"] } },
      input_fields: [{ name: "name", type: "string", required: true }]
    )

    user_factory = Autonoma::Factory.define_factory(
      create: ->(data, ctx) {
        captured_ctx["refs"] = ctx.refs.dup
        captured_ctx["test_run_id"] = ctx.test_run_id
        { "id" => "user-ctx", "email" => data["email"], "name" => data["name"] }
      },
      input_fields: [
        { name: "email", type: "string", required: true },
        { name: "name", type: "string", required: true }
      ]
    )

    config = make_factory_config(
      factories: {
        "Organization" => org_factory,
        "User" => user_factory
      }
    )
    req = make_request(
      {
        "action" => "up",
        "create" => {
          "Organization" => [{ "name" => "Org" }],
          "User" => [{ "email" => "x@y.com", "name" => "X" }]
        },
        "testRunId" => "run-7"
      }
    )
    Autonoma::Handler.handle_request(config, req)

    assert captured_ctx.key?("refs"), "Factory context should have refs"
    assert captured_ctx["refs"].key?("Organization"), "Refs should contain Organization"
    assert_equal 1, captured_ctx["refs"]["Organization"].length
    assert_equal "org-ctx", captured_ctx["refs"]["Organization"][0]["id"]
    assert_equal "run-7", captured_ctx["test_run_id"]
  end

  def test_no_factory_for_model_raises
    org_factory = Autonoma::Factory.define_factory(
      create: ->(data, _ctx) { { "id" => "org-1", "name" => data["name"] } },
      input_fields: [{ name: "name", type: "string", required: true }]
    )

    config = make_factory_config(
      factories: { "Organization" => org_factory }
    )

    req = make_request(
      {
        "action" => "up",
        "create" => {
          "Organization" => [{ "name" => "Org" }],
          "UnknownModel" => [{ "foo" => "bar" }]
        },
        "testRunId" => "run-8"
      }
    )
    result = Autonoma::Handler.handle_request(config, req)

    assert_equal 400, result.status
    assert_equal "INVALID_BODY", result.body["code"]
    assert_includes result.body["error"], "UnknownModel"
  end
end
