# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/autonoma"

class TestFingerprint < Minitest::Test
  def test_produces_16_char_hex
    fp = Autonoma::Fingerprint.fingerprint({ "name" => "test" })
    assert_equal "7d9fd2051fc32b32", fp
    assert_match(/\A[a-f0-9]{16}\z/, fp)
  end

  def test_order_independent_for_object_keys
    fp1 = Autonoma::Fingerprint.fingerprint({ "z" => 1, "a" => 2, "m" => 3 })
    fp2 = Autonoma::Fingerprint.fingerprint({ "a" => 2, "m" => 3, "z" => 1 })
    assert_equal fp1, fp2
    assert_equal "ebba85cfdc0a724b", fp1
  end

  def test_different_values_different_fingerprints
    fp1 = Autonoma::Fingerprint.fingerprint({ "a" => 1 })
    fp2 = Autonoma::Fingerprint.fingerprint({ "a" => 2 })
    refute_equal fp1, fp2
  end

  def test_handles_arrays
    fp = Autonoma::Fingerprint.fingerprint([1, 2, 3])
    assert_equal "a615eeaee21de517", fp
  end

  def test_handles_strings
    fp = Autonoma::Fingerprint.fingerprint("hello")
    assert_equal "5aa762ae383fbb72", fp
  end

  def test_handles_numbers
    fp = Autonoma::Fingerprint.fingerprint(42)
    assert_equal "73475cb40a568e8d", fp
  end

  def test_simple_object
    fp = Autonoma::Fingerprint.fingerprint({ "a" => 1 })
    assert_equal "015abd7f5cc57a2d", fp
  end
end
