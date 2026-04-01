defmodule Autonoma.HMACTest do
  use ExUnit.Case, async: true

  alias Autonoma.HMAC

  @secret "test-secret-key"
  @body "hello world"

  describe "sign_body/2" do
    test "produces deterministic output" do
      sig1 = HMAC.sign_body(@body, @secret)
      sig2 = HMAC.sign_body(@body, @secret)
      assert sig1 == sig2
    end

    test "produces a 64-character hex string" do
      sig = HMAC.sign_body(@body, @secret)
      assert byte_size(sig) == 64
      assert Regex.match?(~r/^[0-9a-f]{64}$/, sig)
    end
  end

  describe "verify_signature/3" do
    test "accepts a valid signature" do
      sig = HMAC.sign_body(@body, @secret)
      assert HMAC.verify_signature(@body, sig, @secret) == true
    end

    test "rejects an invalid signature" do
      assert HMAC.verify_signature(@body, "invalidsignature", @secret) == false
    end
  end

  describe "different secrets" do
    test "produce different signatures" do
      sig1 = HMAC.sign_body(@body, "secret-a")
      sig2 = HMAC.sign_body(@body, "secret-b")
      assert sig1 != sig2
    end
  end
end
