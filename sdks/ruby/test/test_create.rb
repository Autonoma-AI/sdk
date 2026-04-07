# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/autonoma"

# Records SQL calls and returns canned responses.
# Simulates both Postgres (RETURNING) and MySQL (no RETURNING) behavior.
class FakeExecutor
  attr_reader :queries

  def initialize(returning: true)
    @returning = returning
    @queries = []
    @next_responses = []
  end

  # Queue a response for the next query call
  def stub_response(rows)
    @next_responses << rows
    self
  end

  def query(sql, params = [])
    @queries << { sql: sql, params: params }
    @next_responses.shift || []
  end

  def transaction
    yield self
  end
end

class TestCreate < Minitest::Test
  TABLE_MAP = { "User" => "users" }.freeze
  COL_MAP = { "User" => { "id" => "id", "name" => "name", "email" => "email" } }.freeze

  # ---- insert_one (via create_entities, batch: false) ----

  def test_insert_one_postgres_uses_returning
    executor = FakeExecutor.new
    pg = Autonoma::PostgresDialect.new
    executor.stub_response([{ "id" => "uuid-1", "name" => "Alice", "email" => "a@b.com" }])

    result = Autonoma::Create.create_entities(
      executor, pg, TABLE_MAP, COL_MAP,
      { "User" => { "fields" => [{ "name" => "Alice", "email" => "a@b.com" }], "batch" => false } }
    )

    assert_equal 1, result["User"].length
    assert_equal "Alice", result["User"][0]["name"]
    # Should use INSERT ... RETURNING *
    insert_sql = executor.queries.first[:sql]
    assert_includes insert_sql, "RETURNING *"
    assert_equal 1, executor.queries.length, "Postgres should do a single INSERT...RETURNING, not a separate SELECT"
  end

  def test_insert_one_mysql_does_insert_then_select
    executor = FakeExecutor.new
    mysql = Autonoma::MySQLDialect.new

    # First query: INSERT (returns nothing meaningful for MySQL)
    executor.stub_response([])
    # Second query: SELECT back the inserted row
    executor.stub_response([{ "id" => "uuid-1", "name" => "Alice", "email" => "a@b.com" }])

    result = Autonoma::Create.create_entities(
      executor, mysql, TABLE_MAP, COL_MAP,
      { "User" => { "fields" => [{ "name" => "Alice", "email" => "a@b.com" }], "batch" => false } }
    )

    assert_equal 1, result["User"].length
    assert_equal "Alice", result["User"][0]["name"]
    # Should issue INSERT then SELECT
    assert_equal 2, executor.queries.length, "MySQL should do INSERT + SELECT (no RETURNING)"
    refute_includes executor.queries[0][:sql], "RETURNING"
    assert_includes executor.queries[1][:sql], "SELECT *"
  end

  # ---- insert_one with empty fields ----

  def test_insert_one_empty_fields_postgres_uses_default_values_returning
    executor = FakeExecutor.new
    pg = Autonoma::PostgresDialect.new
    # col_map with no "id" mapping so no UUID is generated
    col_map = { "User" => {} }
    executor.stub_response([{ "id" => "auto-1" }])

    result = Autonoma::Create.create_entities(
      executor, pg, { "User" => "users" }, col_map,
      { "User" => { "fields" => [{}], "batch" => false } }
    )

    assert_equal 1, result["User"].length
    insert_sql = executor.queries.first[:sql]
    assert_includes insert_sql, "DEFAULT VALUES RETURNING *"
  end

  def test_insert_one_empty_fields_mysql_does_insert_then_select
    executor = FakeExecutor.new
    mysql = Autonoma::MySQLDialect.new

    # With id column mapped, a UUID gets generated so fields won't be truly empty.
    # Use col_map with id to trigger UUID generation, then the normal MySQL path.
    executor.stub_response([])
    executor.stub_response([{ "id" => "uuid-1" }])

    result = Autonoma::Create.create_entities(
      executor, mysql, TABLE_MAP, COL_MAP,
      { "User" => { "fields" => [{}], "batch" => false } }
    )

    assert_equal 1, result["User"].length
    assert_equal 2, executor.queries.length, "MySQL should INSERT + SELECT"
    refute_includes executor.queries[0][:sql], "RETURNING"
  end

  # ---- batch insert ----

  def test_batch_insert_postgres_uses_returning
    executor = FakeExecutor.new
    pg = Autonoma::PostgresDialect.new
    executor.stub_response([
      { "id" => "u1", "name" => "Alice", "email" => "a@b.com" },
      { "id" => "u2", "name" => "Bob", "email" => "b@b.com" }
    ])

    result = Autonoma::Create.create_entities(
      executor, pg, TABLE_MAP, COL_MAP,
      { "User" => { "fields" => [
        { "name" => "Alice", "email" => "a@b.com" },
        { "name" => "Bob", "email" => "b@b.com" }
      ], "batch" => true } }
    )

    assert_equal 2, result["User"].length
    assert_equal 1, executor.queries.length, "Postgres batch should be a single INSERT...RETURNING"
    assert_includes executor.queries[0][:sql], "RETURNING *"
  end

  def test_batch_insert_mysql_returns_rows_via_select
    executor = FakeExecutor.new
    mysql = Autonoma::MySQLDialect.new

    # First: the INSERT
    executor.stub_response([])
    # Second: the SELECT back by IDs
    executor.stub_response([
      { "id" => "u1", "name" => "Alice", "email" => "a@b.com" },
      { "id" => "u2", "name" => "Bob", "email" => "b@b.com" }
    ])

    result = Autonoma::Create.create_entities(
      executor, mysql, TABLE_MAP, COL_MAP,
      { "User" => { "fields" => [
        { "name" => "Alice", "email" => "a@b.com" },
        { "name" => "Bob", "email" => "b@b.com" }
      ], "batch" => true } }
    )

    assert_equal 2, result["User"].length, "MySQL batch must return rows (via SELECT) not an empty array"
    assert_equal 2, executor.queries.length
    refute_includes executor.queries[0][:sql], "RETURNING"
    assert_includes executor.queries[1][:sql], "SELECT *"
    assert_includes executor.queries[1][:sql], "IN"
  end

  # ---- batch field validation ----

  def test_batch_rejects_inconsistent_fields
    executor = FakeExecutor.new
    pg = Autonoma::PostgresDialect.new

    err = assert_raises(RuntimeError) do
      Autonoma::Create.create_entities(
        executor, pg, TABLE_MAP, COL_MAP,
        { "User" => { "fields" => [
          { "name" => "Alice", "email" => "a@b.com" },
          { "name" => "Bob", "extra" => "bad" }
        ], "batch" => true } }
      )
    end

    assert_includes err.message, "Inconsistent batch insert fields"
  end

  # ---- unknown model ----

  def test_raises_on_unknown_model
    executor = FakeExecutor.new
    pg = Autonoma::PostgresDialect.new

    err = assert_raises(RuntimeError) do
      Autonoma::Create.create_entities(
        executor, pg, TABLE_MAP, COL_MAP,
        { "Unknown" => { "fields" => [{ "name" => "x" }], "batch" => false } }
      )
    end

    assert_includes err.message, "Unknown model"
  end

  # ---- update_entity ----

  def test_update_entity_generates_correct_sql
    executor = FakeExecutor.new
    pg = Autonoma::PostgresDialect.new
    executor.stub_response([])

    Autonoma::Create.update_entity(
      executor, pg, TABLE_MAP, COL_MAP,
      "User", "uuid-1", { "name" => "Updated" }
    )

    assert_equal 1, executor.queries.length
    sql = executor.queries[0][:sql]
    assert_includes sql, "UPDATE"
    assert_includes sql, '"name"'
    assert_equal ["Updated", "uuid-1"], executor.queries[0][:params]
  end

  # ---- column mapping ----

  def test_maps_columns_back_from_db_names
    executor = FakeExecutor.new
    pg = Autonoma::PostgresDialect.new
    col_map = { "User" => { "id" => "id", "firstName" => "first_name", "lastName" => "last_name" } }
    executor.stub_response([{ "id" => "u1", "first_name" => "Alice", "last_name" => "Smith" }])

    result = Autonoma::Create.create_entities(
      executor, pg, TABLE_MAP, col_map,
      { "User" => { "fields" => [{ "firstName" => "Alice", "lastName" => "Smith" }], "batch" => false } }
    )

    record = result["User"][0]
    assert_equal "Alice", record["firstName"]
    assert_equal "Smith", record["lastName"]
  end
end
