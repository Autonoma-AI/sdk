defmodule Autonoma.FingerprintTest do
  use ExUnit.Case, async: true

  alias Autonoma.Fingerprint

  describe "compute/1" do
    test "produces a 16-char hex string" do
      result = Fingerprint.compute(%{"hello" => "world"})
      assert byte_size(result) == 16
      assert Regex.match?(~r/^[0-9a-f]{16}$/, result)
    end

    test "is order-independent for map keys" do
      map1 = %{"b" => 2, "a" => 1}
      map2 = %{"a" => 1, "b" => 2}
      assert Fingerprint.compute(map1) == Fingerprint.compute(map2)
    end

    test "different data produces different fingerprint" do
      fp1 = Fingerprint.compute(%{"key" => "value1"})
      fp2 = Fingerprint.compute(%{"key" => "value2"})
      assert fp1 != fp2
    end

    test "handles nested structures" do
      nested = %{
        "outer" => %{
          "inner" => [1, 2, 3],
          "deep" => %{"leaf" => true}
        }
      }

      result = Fingerprint.compute(nested)
      assert byte_size(result) == 16
      assert Regex.match?(~r/^[0-9a-f]{16}$/, result)

      # Same nested structure with different key order yields same fingerprint
      nested2 = %{
        "outer" => %{
          "deep" => %{"leaf" => true},
          "inner" => [1, 2, 3]
        }
      }

      assert Fingerprint.compute(nested) == Fingerprint.compute(nested2)
    end
  end
end
