# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/autonoma"

class TestHmac < Minitest::Test
  def test_signs_json_body_deterministically
    sig = Autonoma::Hmac.sign_body('{"action":"discover"}', "test-secret-key")
    assert_equal "2c5588170f06ff28479566d72d45969927913c56bcba01d36c3122f2284cbba2", sig
  end

  def test_signs_empty_body
    sig = Autonoma::Hmac.sign_body("", "test-secret-key")
    assert_equal "d1011b593027040df27a8cdd7a95af3021523909894a214033c69b508fcb9b05", sig
  end

  def test_different_secret_different_signature
    sig = Autonoma::Hmac.sign_body('{"action":"up","environment":"standard"}', "another-secret")
    assert_equal "ef2e8267e43842c889f86b436a407d62d3d29e43a82005b1f21a0b49d6e584c8", sig
  end

  def test_produces_64_char_hex
    sig = Autonoma::Hmac.sign_body("any body", "any-secret")
    assert_match(/\A[a-f0-9]{64}\z/, sig)
  end

  def test_verifies_valid_signature
    assert Autonoma::Hmac.verify_signature(
      '{"action":"discover"}',
      "2c5588170f06ff28479566d72d45969927913c56bcba01d36c3122f2284cbba2",
      "test-secret-key"
    )
  end

  def test_rejects_invalid_signature
    refute Autonoma::Hmac.verify_signature(
      '{"action":"discover"}',
      "0000000000000000000000000000000000000000000000000000000000000000",
      "test-secret-key"
    )
  end

  def test_rejects_wrong_secret
    refute Autonoma::Hmac.verify_signature(
      '{"action":"discover"}',
      "2c5588170f06ff28479566d72d45969927913c56bcba01d36c3122f2284cbba2",
      "wrong-secret"
    )
  end

  def test_rejects_different_body
    refute Autonoma::Hmac.verify_signature(
      '{"action":"up"}',
      "2c5588170f06ff28479566d72d45969927913c56bcba01d36c3122f2284cbba2",
      "test-secret-key"
    )
  end
end
