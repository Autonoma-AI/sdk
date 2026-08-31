# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/autonoma"

class TestRefs < Minitest::Test
  def test_produces_3_part_token
    token = Autonoma::Refs.sign_refs(
      { "refs" => { "userId" => "user-1", "email" => "test@test.com" },
        "testRunId" => "test-run-123", "environment" => "standard" },
      "signing-secret"
    )
    parts = token.split(".")
    assert_equal 3, parts.length
    assert_match(/\A[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\z/, token)
  end

  def test_round_trips_arbitrary_json_refs
    payload = {
      "refs" => { "userId" => "user-1", "nested" => { "count" => 3 } },
      "testRunId" => "test-run-123",
      "environment" => "standard"
    }
    secret = "signing-secret"
    token = Autonoma::Refs.sign_refs(payload, secret)
    got = Autonoma::Refs.verify_refs(token, secret)

    assert_equal "test-run-123", got["testRunId"]
    assert_equal "standard", got["environment"]
    assert_equal "user-1", got["refs"]["userId"]
    assert_equal 3, got["refs"]["nested"]["count"]
  end

  def test_round_trips_canonical_cross_language_token
    token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IlJFRlMifQ.eyJyZWZzIjp7IlVzZXIiOlt7ImlkIjoidXNlci0xIiwiZW1haWwiOiJ0ZXN0QHRlc3QuY29tIn1dfSwidGVzdFJ1bklkIjoidGVzdC1ydW4tMTIzIiwiZW52aXJvbm1lbnQiOiJzdGFuZGFyZCJ9.b2340UY6iXALRK2SaBV0BzZLVbxC8J59_csCUEc-gOw"
    payload = Autonoma::Refs.verify_refs(token, "signing-secret")
    expected = {
      "refs" => { "User" => [{ "id" => "user-1", "email" => "test@test.com" }] },
      "testRunId" => "test-run-123",
      "environment" => "standard"
    }
    assert_equal expected, payload
  end

  def test_rejects_wrong_secret
    token = Autonoma::Refs.sign_refs(
      { "refs" => {}, "testRunId" => "r", "environment" => "e" }, "right-secret"
    )
    assert_raises(RuntimeError) { Autonoma::Refs.verify_refs(token, "wrong-secret") }
  end

  def test_rejects_malformed_token
    assert_raises(RuntimeError) { Autonoma::Refs.verify_refs("only-one-part", "signing-secret") }
  end

  def test_rejects_tampered_payload
    token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IlJFRlMifQ.dGFtcGVyZWQ.b2340UY6iXALRK2SaBV0BzZLVbxC8J59_csCUEc-gOw"
    assert_raises(RuntimeError) { Autonoma::Refs.verify_refs(token, "signing-secret") }
  end
end
