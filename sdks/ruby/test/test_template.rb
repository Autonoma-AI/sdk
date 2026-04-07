# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/autonoma"

class TestTemplate < Minitest::Test
  def test_resolves_test_run_id
    result = Autonoma::Template.resolve_template("{{testRunId}}", { "testRunId" => "run-abc123", "index" => 0 })
    assert_equal "run-abc123", result
    assert_kind_of String, result
  end

  def test_resolves_index_preserves_number
    result = Autonoma::Template.resolve_template("{{index}}", { "testRunId" => "x", "index" => 2 })
    assert_equal 2, result
    assert_kind_of Integer, result
  end

  def test_resolves_index1
    result = Autonoma::Template.resolve_template("{{index1}}", { "testRunId" => "x", "index" => 2 })
    assert_equal 3, result
    assert_kind_of Integer, result
  end

  def test_interpolates_in_strings
    result = Autonoma::Template.resolve_template(
      "admin-{{testRunId}}@autonoma.dev",
      { "testRunId" => "run-abc123", "index" => 0 }
    )
    assert_equal "admin-run-abc123@autonoma.dev", result
    assert_kind_of String, result
  end

  def test_index_interpolation_coerces_to_string
    result = Autonoma::Template.resolve_template("item-{{index}}", { "testRunId" => "x", "index" => 5 })
    assert_equal "item-5", result
    assert_kind_of String, result
  end

  def test_resolves_cycle
    result = Autonoma::Template.resolve_template(
      "{{cycle(['active','inactive','draft'])}}",
      { "testRunId" => "x", "index" => 0 }
    )
    assert_equal "active", result
  end

  def test_resolves_cycle_at_index_1
    result = Autonoma::Template.resolve_template(
      "{{cycle(['active','inactive','draft'])}}",
      { "testRunId" => "x", "index" => 1 }
    )
    assert_equal "inactive", result
  end

  def test_resolves_cycle_wraps_around
    result = Autonoma::Template.resolve_template(
      "{{cycle(['active','inactive','draft'])}}",
      { "testRunId" => "x", "index" => 4 }
    )
    assert_equal "inactive", result
  end

  def test_passes_through_non_template_strings
    result = Autonoma::Template.resolve_template("plain string", { "testRunId" => "x", "index" => 0 })
    assert_equal "plain string", result
  end

  def test_passes_through_numbers
    result = Autonoma::Template.resolve_template(42, { "testRunId" => "x", "index" => 0 })
    assert_equal 42, result
    assert_kind_of Integer, result
  end

  def test_passes_through_booleans
    result = Autonoma::Template.resolve_template(true, { "testRunId" => "x", "index" => 0 })
    assert_equal true, result
  end

  def test_passes_through_null
    result = Autonoma::Template.resolve_template(nil, { "testRunId" => "x", "index" => 0 })
    assert_nil result
  end

  def test_resolves_nested_objects
    result = Autonoma::Template.resolve_template(
      { "name" => "User {{index1}}", "runId" => "{{testRunId}}" },
      { "testRunId" => "run-abc123", "index" => 2 }
    )
    assert_equal({ "name" => "User 3", "runId" => "run-abc123" }, result)
  end

  def test_resolves_arrays
    result = Autonoma::Template.resolve_template(
      ["{{testRunId}}", "{{index}}", "static"],
      { "testRunId" => "run-1", "index" => 0 }
    )
    assert_equal ["run-1", 0, "static"], result
  end

  def test_now_returns_iso_string
    result = Autonoma::Template.resolve_template("{{now()}}", { "testRunId" => "x", "index" => 0 })
    assert_kind_of String, result
    assert_match(/\A\d{4}-\d{2}-\d{2}T/, result)
  end

  def test_random_int_returns_integer_in_range
    result = Autonoma::Template.resolve_template("{{random.int(1,100)}}", { "testRunId" => "x", "index" => 0 })
    assert_kind_of Integer, result
    assert_operator result, :>=, 1
    assert_operator result, :<=, 100
  end

  def test_random_float_returns_float_in_range
    result = Autonoma::Template.resolve_template("{{random.float(0,1)}}", { "testRunId" => "x", "index" => 0 })
    assert_kind_of Numeric, result
    assert_operator result, :>=, 0
    assert_operator result, :<=, 1
  end

  def test_pick_returns_one_of_items
    result = Autonoma::Template.resolve_template("{{pick(['a','b','c'])}}", { "testRunId" => "x", "index" => 0 })
    assert_includes %w[a b c], result
  end
end
