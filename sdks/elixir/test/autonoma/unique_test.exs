defmodule Autonoma.UniqueTest do
  use ExUnit.Case, async: true

  alias Autonoma.Unique

  # These vectors are cross-checked against the TypeScript unique.ts recipe so
  # the same (test_run_id, ...parts) yields byte-identical output across all
  # language SDKs.
  test "cross-language vectors" do
    assert Unique.unique_token("run-1") == "4e65d3fbe8ad"
    assert Unique.unique_email("run-1") == "user+039af36014b8@example.com"
    assert Unique.unique_slug("run-1", "Acme") == "acme-b6446df155f8"
    assert Unique.unique_id("run-1", "user") == "user_776b5cbfd0f0"
  end

  test "token shape" do
    token = Unique.unique_token("run", ["a", "b"])
    assert String.length(token) == 12
    assert Regex.match?(~r/^[0-9a-f]{12}$/, token)
  end

  test "deterministic and seeded" do
    # Same inputs, same output.
    assert Unique.unique_token("run", ["x"]) == Unique.unique_token("run", ["x"])
    # Different test_run_id, different output.
    assert Unique.unique_token("run-a", ["x"]) != Unique.unique_token("run-b", ["x"])
    # Different parts, different output.
    assert Unique.unique_token("run", ["x"]) != Unique.unique_token("run", ["y"])
  end

  test "slug normalization" do
    assert Regex.match?(~r/^acme-corp-[0-9a-f]{12}$/, Unique.unique_slug("run", "Acme Corp!!"))
    # A base that normalizes to empty falls back to "item".
    assert Regex.match?(~r/^item-[0-9a-f]{12}$/, Unique.unique_slug("run", "!!!"))
  end

  test "defaults for empty inputs" do
    assert Unique.unique_id("run", "") == "id_" <> Unique.unique_token("run", ["id"])
    assert String.starts_with?(Unique.unique_slug("run", ""), "item-")
    assert String.ends_with?(Unique.unique_email("run", "", ""), "@example.com")
  end
end
