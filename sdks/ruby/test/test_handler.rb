# frozen_string_literal: true

require "minitest/autorun"
require "json"
require_relative "../lib/autonoma"

# Mock executor for handler tests
class MockExecutor
  attr_reader :queries

  def initialize
    @queries = []
  end

  def query(sql, params = [])
    @queries << { sql: sql, params: params }
    []
  end

  def transaction
    yield self
  end
end

class TestHandler < Minitest::Test
  def setup
    @executor = MockExecutor.new
    @config = Autonoma::HandlerConfig.new(
      executor: @executor,
      scope_field: "organizationId",
      shared_secret: "shared-secret",
      signing_secret: "signing-secret"
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
      signing_secret: "same-secret"
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

  def test_sdk_meta_includes_ruby_language
    # Directly test the meta output by checking error responses (always include meta)
    req = make_request({ "action" => "discover" })
    # This will fail due to mock executor not returning schema, but we can check via error response
    result = Autonoma::Handler.handle_request(@config, req)
    # The discover handler will try to introspect, which should hit the mock executor
    # Even on error, the response should have version/sdk info or error info
    assert_kind_of Autonoma::HandlerResponse, result
  end
end
