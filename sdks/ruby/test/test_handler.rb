# frozen_string_literal: true

require "minitest/autorun"
require "json"
require "securerandom"
require_relative "../lib/autonoma"

# Mock executor that returns canned introspection results for handler tests.
class HandlerMockExecutor
  attr_reader :queries

  def initialize
    @queries = []
  end

  def query(sql, params = [])
    @queries << { sql: sql, params: params }

    # Return minimal introspection data for discover to succeed
    if sql.include?("information_schema.tables")
      [{ "table_name" => "users" }]
    elsif sql.include?("information_schema.columns")
      [
        { "table_name" => "users", "column_name" => "id", "data_type" => "uuid",
          "udt_name" => "uuid", "is_nullable" => "NO", "column_default" => "gen_random_uuid()" },
        { "table_name" => "users", "column_name" => "name", "data_type" => "character varying",
          "udt_name" => "varchar", "is_nullable" => "NO", "column_default" => nil },
        { "table_name" => "users", "column_name" => "email", "data_type" => "character varying",
          "udt_name" => "varchar", "is_nullable" => "NO", "column_default" => nil }
      ]
    elsif sql.include?("PRIMARY KEY")
      [{ "table_name" => "users", "column_name" => "id" }]
    elsif sql.include?("FOREIGN KEY") || sql.include?("foreign_keys")
      []
    elsif sql.include?("pg_enum") || sql.include?("enum")
      []
    elsif sql.include?("INSERT")
      [{ "id" => "user-#{SecureRandom.hex(4)}", "name" => "Test", "email" => "test@test.com" }]
    elsif sql.include?("DELETE")
      []
    else
      []
    end
  end

  def transaction
    yield self
  end
end

class TestHandler < Minitest::Test
  def setup
    @executor = HandlerMockExecutor.new
    @config = Autonoma::HandlerConfig.new(
      executor: @executor,
      scope_field: "organizationId",
      shared_secret: "shared-secret",
      signing_secret: "signing-secret",
      auth: ->(user) { { "headers" => { "Authorization" => "Bearer test-token-#{user ? user['id'] : 'anon'}" } } }
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
      executor: @executor,
      scope_field: "organizationId",
      shared_secret: "same-secret",
      signing_secret: "same-secret",
      auth: ->(user) { { "headers" => {} } }
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

  def test_discover_returns_sdk_meta_with_ruby
    req = make_request({ "action" => "discover" })
    result = Autonoma::Handler.handle_request(@config, req)

    assert_equal 200, result.status
    assert_equal "1.0", result.body["version"]
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
  end

  def test_after_up_hook_modifies_auth
    config = Autonoma::HandlerConfig.new(
      executor: @executor,
      scope_field: "organizationId",
      shared_secret: "shared-secret",
      signing_secret: "signing-secret",
      auth: ->(user) { { "headers" => { "Authorization" => "Bearer test-token" } } },
      after_up: ->(hook_ctx, auth) {
        auth["headers"]["X-Custom"] = "enriched"
        auth
      }
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

    config = Autonoma::HandlerConfig.new(
      executor: @executor,
      scope_field: "organizationId",
      shared_secret: "shared-secret",
      signing_secret: "signing-secret",
      auth: ->(user) { { "headers" => {} } },
      before_down: ->(hook_ctx) {
        hook_called = true
        captured_ctx = hook_ctx
      }
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
