# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/autonoma"

class TestUnique < Minitest::Test
  # These vectors are cross-checked against the TypeScript unique.ts recipe so
  # the same (test_run_id, ...parts) yields byte-identical output across
  # languages.
  def test_cross_language_vectors
    assert_equal "4e65d3fbe8ad", Autonoma::Unique.unique_token("run-1")
    assert_equal "user+039af36014b8@example.com", Autonoma::Unique.unique_email("run-1")
    assert_equal "acme-b6446df155f8", Autonoma::Unique.unique_slug("run-1", "Acme")
    assert_equal "user_776b5cbfd0f0", Autonoma::Unique.unique_id("run-1", "user")
  end

  def test_token_shape
    token = Autonoma::Unique.unique_token("run", "a", "b")
    assert_equal 12, token.length
    assert_match(/\A[0-9a-f]{12}\z/, token)
  end

  def test_deterministic_and_seeded
    assert_equal Autonoma::Unique.unique_token("run", "x"), Autonoma::Unique.unique_token("run", "x")
    refute_equal Autonoma::Unique.unique_token("run-a", "x"), Autonoma::Unique.unique_token("run-b", "x")
    refute_equal Autonoma::Unique.unique_token("run", "x"), Autonoma::Unique.unique_token("run", "y")
  end

  def test_slug_normalization
    assert_match(/\Aacme-corp-[0-9a-f]{12}\z/, Autonoma::Unique.unique_slug("run", "Acme Corp!!"))
    # A base that normalizes to empty falls back to "item".
    assert_match(/\Aitem-[0-9a-f]{12}\z/, Autonoma::Unique.unique_slug("run", "!!!"))
  end
end
