defmodule Autonoma.RefsTest do
  use ExUnit.Case, async: true

  alias Autonoma.Refs

  @secret "refs-test-secret"

  describe "sign/2 and verify!/2" do
    test "round-trip sign then verify returns original payload" do
      payload = %{"testRunId" => "abc-123", "refs" => %{"User" => [%{"id" => 1}]}}
      token = Refs.sign(payload, @secret)
      decoded = Refs.verify!(token, @secret)

      assert decoded["testRunId"] == "abc-123"
      assert decoded["refs"]["User"] == [%{"id" => 1}]
    end
  end

  describe "token format" do
    test "has 3 dot-separated parts" do
      token = Refs.sign(%{"foo" => "bar"}, @secret)
      parts = String.split(token, ".")
      assert length(parts) == 3
    end
  end

  describe "verification failures" do
    test "rejects wrong secret" do
      token = Refs.sign(%{"data" => true}, @secret)

      assert_raise RuntimeError, "signature mismatch", fn ->
        Refs.verify!(token, "wrong-secret")
      end
    end

    test "rejects tampered token" do
      token = Refs.sign(%{"data" => true}, @secret)
      [header, _body, signature] = String.split(token, ".")
      tampered_body = Base.url_encode64(Jason.encode!(%{"data" => false}), padding: false)
      tampered_token = "#{header}.#{tampered_body}.#{signature}"

      assert_raise RuntimeError, "signature mismatch", fn ->
        Refs.verify!(tampered_token, @secret)
      end
    end
  end
end
