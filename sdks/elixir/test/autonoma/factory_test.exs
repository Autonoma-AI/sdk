defmodule Autonoma.FactoryTest do
  use ExUnit.Case, async: true

  alias Autonoma.Factory

  # ===========================================================================
  # Factory module validation tests
  # ===========================================================================

  test "define_factory requires create and input_fields" do
    assert_raise ArgumentError, ~r/must include/, fn ->
      Factory.define_factory(%{})
    end
  end

  test "define_factory requires input_fields" do
    assert_raise ArgumentError, ~r/input_fields/, fn ->
      Factory.define_factory(%{create: fn _d, _c -> %{} end})
    end
  end

  test "define_factory validates create is a 2-arity function" do
    assert_raise ArgumentError, fn ->
      Factory.define_factory(%{
        create: "not a function",
        input_fields: [%{name: "name", type: :string, required: true}]
      })
    end
  end

  test "define_factory validates teardown if provided" do
    assert_raise ArgumentError, fn ->
      Factory.define_factory(%{
        create: fn _d, _c -> %{} end,
        input_fields: [%{name: "name", type: :string, required: true}],
        teardown: "not a function"
      })
    end
  end

  test "define_factory accepts valid definition with input_fields" do
    factory =
      Factory.define_factory(%{
        create: fn data, _ctx -> %{"id" => "1", "name" => data["name"]} end,
        input_fields: [
          %{name: "name", type: :string, required: true},
          %{name: "email", type: :string, required: false}
        ]
      })

    assert is_function(factory.create, 2)
    assert factory.teardown == nil
    assert length(factory.input_fields) == 2
  end

  test "define_factory accepts definition with teardown and ref_fields" do
    factory =
      Factory.define_factory(%{
        create: fn data, _ctx -> %{"id" => "1", "name" => data["name"]} end,
        input_fields: [%{name: "name", type: :string, required: true}],
        teardown: fn _record, _ctx -> :ok end,
        ref_fields: [%{name: "id", type: :string, required: true}]
      })

    assert is_function(factory.teardown, 2)
    assert factory.ref_fields != nil
  end

  # ===========================================================================
  # Input validation tests
  # ===========================================================================

  test "validate_input strips unknown keys" do
    input_fields = [
      %{name: "name", type: :string, required: true},
      %{name: "email", type: :string, required: false}
    ]

    {:ok, validated} =
      Factory.validate_input(%{"name" => "Alice", "email" => "a@b.com", "unknown" => "x"}, input_fields)

    assert validated == %{"name" => "Alice", "email" => "a@b.com"}
  end

  test "validate_input catches missing required fields" do
    input_fields = [
      %{name: "name", type: :string, required: true},
      %{name: "email", type: :string, required: true}
    ]

    {:error, reason} = Factory.validate_input(%{"name" => "Alice"}, input_fields)
    assert reason =~ "email"
  end

  test "validate_input passes when all required fields present" do
    input_fields = [
      %{name: "name", type: :string, required: true}
    ]

    {:ok, validated} = Factory.validate_input(%{"name" => "Alice"}, input_fields)
    assert validated == %{"name" => "Alice"}
  end

  test "validate_input passes with optional fields missing" do
    input_fields = [
      %{name: "name", type: :string, required: true},
      %{name: "bio", type: :string, required: false}
    ]

    {:ok, validated} = Factory.validate_input(%{"name" => "Alice"}, input_fields)
    assert validated == %{"name" => "Alice"}
  end
end
