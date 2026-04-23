# frozen_string_literal: true

require "minitest/autorun"
require "autonoma/handler"

class TokenResolutionTest < Minitest::Test
  def test_testrunid_substituted
    out = Autonoma::Handler.resolve_tokens({ "email" => "alice-{{testRunId}}@test.local" }, "run-123", 0)
    assert_equal({ "email" => "alice-run-123@test.local" }, out)
  end

  def test_index_substituted
    out = Autonoma::Handler.resolve_tokens({ "slot" => "pos-{{index}}" }, "r", 4)
    assert_equal({ "slot" => "pos-4" }, out)
  end

  def test_cycle_substituted_and_wraps
    assert_equal "a", Autonoma::Handler.resolve_tokens("{{cycle(a,b)}}", "r", 0)
    assert_equal "b", Autonoma::Handler.resolve_tokens("{{cycle(a,b)}}", "r", 1)
    assert_equal "a", Autonoma::Handler.resolve_tokens("{{cycle(a,b)}}", "r", 2)
  end

  def test_cycle_quoted_values_stripped
    assert_equal "IOS", Autonoma::Handler.resolve_tokens("{{cycle('WEB','IOS','ANDROID')}}", "r", 1)
  end

  def test_nested_structures_walked
    input = {
      "users" => [
        { "email" => "u-{{testRunId}}@t.local" },
        { "email" => "v-{{testRunId}}@t.local" }
      ],
      "tags" => ["{{testRunId}}-a", "{{testRunId}}-b"]
    }
    expected = {
      "users" => [
        { "email" => "u-xyz@t.local" },
        { "email" => "v-xyz@t.local" }
      ],
      "tags" => ["xyz-a", "xyz-b"]
    }
    assert_equal expected, Autonoma::Handler.resolve_tokens(input, "xyz", 0)
  end

  def test_multiple_tokens_in_one_string
    assert_equal "run-7", Autonoma::Handler.resolve_tokens("{{testRunId}}-{{index}}", "run", 7)
  end

  def test_unknown_token_raises
    err = assert_raises(Autonoma::AutonomaError) do
      Autonoma::Handler.resolve_tokens({ "x" => "hello-{{mystery}}" }, "r", 0)
    end
    assert_equal "UNRESOLVED_TOKEN", err.code
    assert_includes err.message, "mystery"
  end

  def test_non_string_primitives_pass_through
    assert_equal 42, Autonoma::Handler.resolve_tokens(42, "r", 0)
    assert_equal true, Autonoma::Handler.resolve_tokens(true, "r", 0)
    assert_nil Autonoma::Handler.resolve_tokens(nil, "r", 0)
  end

  def test_string_without_tokens_unchanged
    assert_equal "plain string", Autonoma::Handler.resolve_tokens("plain string", "r", 0)
  end
end
