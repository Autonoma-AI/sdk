defmodule Autonoma.TokenResolutionTest do
  use ExUnit.Case, async: true

  alias Autonoma.Handler

  test "testRunId substitutes" do
    assert Handler.resolve_tokens(%{"email" => "alice-{{testRunId}}@test.local"}, "run-123", 0) ==
             %{"email" => "alice-run-123@test.local"}
  end

  test "index substitutes" do
    assert Handler.resolve_tokens(%{"slot" => "pos-{{index}}"}, "r", 4) ==
             %{"slot" => "pos-4"}
  end

  test "cycle substitutes and wraps" do
    assert Handler.resolve_tokens("{{cycle(a,b)}}", "r", 0) == "a"
    assert Handler.resolve_tokens("{{cycle(a,b)}}", "r", 1) == "b"
    assert Handler.resolve_tokens("{{cycle(a,b)}}", "r", 2) == "a"
  end

  test "cycle strips quoted values" do
    assert Handler.resolve_tokens("{{cycle('WEB','IOS','ANDROID')}}", "r", 1) == "IOS"
  end

  test "nested structures walked recursively" do
    input = %{
      "users" => [
        %{"email" => "u-{{testRunId}}@t.local"},
        %{"email" => "v-{{testRunId}}@t.local"}
      ],
      "tags" => ["{{testRunId}}-a", "{{testRunId}}-b"]
    }

    assert Handler.resolve_tokens(input, "xyz", 0) == %{
             "users" => [
               %{"email" => "u-xyz@t.local"},
               %{"email" => "v-xyz@t.local"}
             ],
             "tags" => ["xyz-a", "xyz-b"]
           }
  end

  test "multiple tokens in one string resolve independently" do
    assert Handler.resolve_tokens("{{testRunId}}-{{index}}", "run", 7) == "run-7"
  end

  test "unknown token raises UNRESOLVED_TOKEN" do
    err =
      assert_raise Autonoma.Error, fn ->
        Handler.resolve_tokens(%{"x" => "hello-{{mystery}}"}, "r", 0)
      end

    assert err.code == "UNRESOLVED_TOKEN"
    assert err.message =~ "mystery"
  end

  test "non-string primitives pass through unchanged" do
    assert Handler.resolve_tokens(42, "r", 0) == 42
    assert Handler.resolve_tokens(true, "r", 0) == true
    assert Handler.resolve_tokens(nil, "r", 0) == nil
  end

  test "strings without tokens unchanged" do
    assert Handler.resolve_tokens("plain string", "r", 0) == "plain string"
  end
end
