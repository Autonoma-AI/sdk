defmodule Autonoma.TemplateTest do
  use ExUnit.Case, async: true

  alias Autonoma.Template

  @ctx %{"testRunId" => "run-42", "index" => 2}

  describe "resolve/2" do
    test "resolves testRunId" do
      assert Template.resolve("{{testRunId}}", @ctx) == "run-42"
    end

    test "resolves index" do
      assert Template.resolve("{{index}}", @ctx) == 2
    end

    test "resolves cycle expression" do
      # index=2, items=["a","b","c"], rem(2,3)=2 -> "c"
      result = Template.resolve("{{cycle(['a','b','c'])}}", @ctx)
      assert result == "c"
    end

    test "passes through non-template values" do
      assert Template.resolve("plain text", @ctx) == "plain text"
      assert Template.resolve(42, @ctx) == 42
      assert Template.resolve(true, @ctx) == true
      assert Template.resolve(nil, @ctx) == nil
    end

    test "resolves templates inside maps" do
      input = %{"name" => "{{testRunId}}", "count" => 5}
      result = Template.resolve(input, @ctx)
      assert result["name"] == "run-42"
      assert result["count"] == 5
    end

    test "resolves templates inside lists" do
      input = ["{{testRunId}}", "static"]
      result = Template.resolve(input, @ctx)
      assert result == ["run-42", "static"]
    end

    test "interpolates expressions within a larger string" do
      result = Template.resolve("user-{{testRunId}}-{{index}}", @ctx)
      assert result == "user-run-42-2"
    end
  end
end
