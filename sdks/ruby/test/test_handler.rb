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
      auth: ->(user, _ctx) { { "headers" => { "Authorization" => "Bearer test-token-#{user ? user['id'] : 'anon'}" } } }
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
      auth: ->(user, _ctx) { { "headers" => {} } }
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

  def with_env(overrides)
    previous = overrides.keys.each_with_object({}) { |k, h| h[k] = ENV[k] }
    overrides.each { |k, v| v.nil? ? ENV.delete(k) : ENV[k] = v }
    yield
  ensure
    previous.each { |k, v| v.nil? ? ENV.delete(k) : ENV[k] = v }
  end

  def test_blocks_production_when_not_allowed
    with_env("RAILS_ENV" => "production", "AUTONOMA_ENABLED" => nil) do
      req = make_request({ "action" => "discover" })
      result = Autonoma::Handler.handle_request(@config, req)
      assert_equal 404, result.status
      assert_equal "PRODUCTION_BLOCKED", result.body["code"]
    end
  end

  def test_autonoma_enabled_overrides_production_block
    with_env("RAILS_ENV" => "production", "AUTONOMA_ENABLED" => "1") do
      req = make_request({ "action" => "discover" })
      result = Autonoma::Handler.handle_request(@config, req)
      assert_equal 200, result.status
    end
  end

  def test_autonoma_enabled_zero_does_not_override
    with_env("RAILS_ENV" => "production", "AUTONOMA_ENABLED" => "0") do
      req = make_request({ "action" => "discover" })
      result = Autonoma::Handler.handle_request(@config, req)
      assert_equal 404, result.status
      assert_equal "PRODUCTION_BLOCKED", result.body["code"]
    end
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
      auth: ->(user, _context) { { "headers" => { "Authorization" => "Bearer test-token" } } },
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
      auth: ->(user, _context) { { "headers" => {} } },
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

# Mock executor that returns Organization + User introspection data for factory tests.
class FactoryMockExecutor
  attr_reader :queries

  def initialize
    @queries = []
    @insert_counter = 0
  end

  def query(sql, params = [])
    @queries << sql
    trimmed = sql.strip.downcase

    if trimmed.include?("information_schema.tables") && !trimmed.include?("table_constraints")
      [{ "table_name" => "organization" }, { "table_name" => "user" }]
    elsif trimmed.include?("information_schema.columns") && !trimmed.include?("table_constraints")
      [
        { "table_name" => "organization", "column_name" => "id", "data_type" => "uuid",
          "udt_name" => "uuid", "is_nullable" => "NO", "column_default" => "gen_random_uuid()" },
        { "table_name" => "organization", "column_name" => "name", "data_type" => "text",
          "udt_name" => "text", "is_nullable" => "NO", "column_default" => nil },
        { "table_name" => "user", "column_name" => "id", "data_type" => "uuid",
          "udt_name" => "uuid", "is_nullable" => "NO", "column_default" => "gen_random_uuid()" },
        { "table_name" => "user", "column_name" => "email", "data_type" => "text",
          "udt_name" => "text", "is_nullable" => "NO", "column_default" => nil },
        { "table_name" => "user", "column_name" => "name", "data_type" => "text",
          "udt_name" => "text", "is_nullable" => "NO", "column_default" => nil },
        { "table_name" => "user", "column_name" => "organization_id", "data_type" => "uuid",
          "udt_name" => "uuid", "is_nullable" => "NO", "column_default" => nil }
      ]
    elsif trimmed.include?("foreign key")
      [{ "from_table" => "user", "from_column" => "organization_id",
         "to_table" => "organization", "to_column" => "id", "is_nullable" => "NO" }]
    elsif trimmed.include?("primary key")
      [{ "table_name" => "organization", "column_name" => "id" },
       { "table_name" => "user", "column_name" => "id" }]
    elsif trimmed.include?("pg_type")
      []
    elsif trimmed.start_with?("insert")
      @insert_counter += 1
      record = { "id" => "mock-id-#{@insert_counter}" }
      if params&.any?
        col_match = sql.match(/\(([^)]+)\)\s*VALUES/i)
        if col_match
          cols = col_match[1].split(",").map { |c| c.strip.delete('"') }
          cols.each_with_index do |col, i|
            record[col] = params[i] if i < params.length
          end
        end
      end
      [record]
    else
      []
    end
  end

  def transaction
    yield self
  end
end

class TestFactories < Minitest::Test
  def make_factory_config(**overrides)
    defaults = {
      executor: FactoryMockExecutor.new,
      scope_field: "organizationId",
      shared_secret: "test-secret",
      signing_secret: "test-signing-secret",
      auth: ->(_user, _ctx) { { "headers" => { "Authorization" => "Bearer token" } } }
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

    executor = FactoryMockExecutor.new
    config = make_factory_config(
      executor: executor,
      factories: { "Organization" => Autonoma::Factory.define_factory(create: org_create) }
    )
    req = make_request(
      { "action" => "up", "create" => { "Organization" => [{ "name" => "FactoryOrg" }] }, "testRunId" => "run-1" }
    )
    result = Autonoma::Handler.handle_request(config, req)

    assert_equal 200, result.status
    assert_equal 1, calls.length
    assert_equal "FactoryOrg", calls[0]["name"]
    assert_equal "factory-org-1", result.body["refs"]["Organization"][0]["id"]
    # No INSERT for Organization
    org_inserts = executor.queries.select { |q| q.downcase.include?("insert") && q.downcase.include?("organization") }
    assert_equal 0, org_inserts.length
  end

  def test_hybrid_factory_and_sql
    org_create = ->(data, _ctx) {
      { "id" => "factory-org-1", "name" => data["name"] }
    }

    executor = FactoryMockExecutor.new
    config = make_factory_config(
      executor: executor,
      factories: { "Organization" => Autonoma::Factory.define_factory(create: org_create) }
    )
    req = make_request(
      { "action" => "up", "create" => { "Organization" => [{ "name" => "Org" }], "User" => [{ "email" => "a@b.com", "name" => "A" }] }, "testRunId" => "run-2" }
    )
    result = Autonoma::Handler.handle_request(config, req)

    assert_equal 200, result.status
    # User should be created via SQL
    user_inserts = executor.queries.select { |q| q.downcase.include?("insert") && q.downcase.include?('"user"') }
    assert user_inserts.length > 0, "User should be created via SQL INSERT"
  end

  def test_factory_receives_resolved_fk_ids
    received = {}

    org_create = ->(data, _ctx) {
      { "id" => "resolved-org-id", "name" => data["name"] }
    }

    user_create = ->(data, _ctx) {
      received.merge!(data)
      { "id" => "user-1", "email" => data["email"], "organizationId" => data["organizationId"] }
    }

    config = make_factory_config(
      factories: {
        "Organization" => Autonoma::Factory.define_factory(create: org_create),
        "User" => Autonoma::Factory.define_factory(create: user_create)
      }
    )
    # Nest User under Organization so tree resolver wires the FK
    req = make_request(
      { "action" => "up", "create" => { "Organization" => [{ "name" => "Org", "User" => [{ "email" => "a@b.com", "name" => "A" }] }] }, "testRunId" => "run-3" }
    )
    result = Autonoma::Handler.handle_request(config, req)

    assert_equal 200, result.status
    assert_equal "resolved-org-id", received["organizationId"]
  end

  def test_factory_missing_pk_error
    org_create = ->(data, _ctx) {
      { "name" => data["name"] } # missing 'id'
    }

    config = make_factory_config(
      factories: { "Organization" => Autonoma::Factory.define_factory(create: org_create) }
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

    org_create = ->(data, _ctx) {
      { "id" => "org-#{data['name']}", "name" => data["name"] }
    }

    org_teardown = ->(record, _ctx) {
      teardown_calls << record["id"]
    }

    config = make_factory_config(
      factories: { "Organization" => Autonoma::Factory.define_factory(create: org_create, teardown: org_teardown) }
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

  def test_sql_fallback_teardown
    org_create = ->(data, _ctx) {
      { "id" => "org-1", "name" => data["name"] }
    }

    executor = FactoryMockExecutor.new
    config = make_factory_config(
      executor: executor,
      factories: { "Organization" => Autonoma::Factory.define_factory(create: org_create) } # no teardown
    )

    up_req = make_request(
      { "action" => "up", "create" => { "Organization" => [{ "name" => "Org" }] }, "testRunId" => "run-6" }
    )
    up_res = Autonoma::Handler.handle_request(config, up_req)
    assert_equal 200, up_res.status

    down_req = make_request({ "action" => "down", "refsToken" => up_res.body["refsToken"] })
    down_res = Autonoma::Handler.handle_request(config, down_req)

    assert_equal 200, down_res.status
    delete_queries = executor.queries.select { |q| q.downcase.include?("delete") }
    assert delete_queries.length > 0, "SQL DELETE should be used for teardown without factory teardown"
  end

  def test_factory_context_has_refs
    captured_ctx = {}

    org_create = ->(data, _ctx) {
      { "id" => "org-ctx", "name" => data["name"] }
    }

    user_create = ->(data, ctx) {
      captured_ctx["refs"] = ctx.refs.dup
      captured_ctx["test_run_id"] = ctx.test_run_id
      { "id" => "user-ctx", "email" => data["email"], "organizationId" => data["organizationId"] }
    }

    config = make_factory_config(
      factories: {
        "Organization" => Autonoma::Factory.define_factory(create: org_create),
        "User" => Autonoma::Factory.define_factory(create: user_create)
      }
    )
    req = make_request(
      { "action" => "up", "create" => { "Organization" => [{ "name" => "Org" }], "User" => [{ "email" => "x@y.com", "name" => "X" }] }, "testRunId" => "run-7" }
    )
    Autonoma::Handler.handle_request(config, req)

    assert captured_ctx.key?("refs"), "Factory context should have refs"
    assert captured_ctx["refs"].key?("Organization"), "Refs should contain Organization"
    assert_equal 1, captured_ctx["refs"]["Organization"].length
    assert_equal "org-ctx", captured_ctx["refs"]["Organization"][0]["id"]
    assert_equal "run-7", captured_ctx["test_run_id"]
  end
end
