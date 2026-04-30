defmodule Autonoma.Factory do
  @moduledoc """
  Define a factory for creating entities via user code.

  The factory's `create` function receives a validated map of fields
  (with unknown keys stripped and required fields checked) and a
  `FactoryContext`, and must return a record map that includes at
  least `"id"`.

  `input_fields` is **required** because the SDK derives the discover
  schema from it (no DB introspection).
  """

  @doc """
  Validate and return a factory definition map.

  ## Options

    * `:create` (required) — a 2-arity function `(data, ctx) -> record`
    * `:input_fields` (required) — a list of `%{name: string, type: atom, required: boolean}`
    * `:teardown` (optional) — a 2-arity function `(record, ctx) -> any`
    * `:ref_fields` (optional) — field defs for teardown record validation

  ## Examples

      Autonoma.Factory.define_factory(%{
        create: fn data, ctx -> %{"id" => UUID.uuid4(), "name" => data["name"]} end,
        input_fields: [
          %{name: "name", type: :string, required: true},
          %{name: "email", type: :string, required: true}
        ],
        teardown: fn record, ctx -> MyApp.cleanup(record) end
      })
  """
  def define_factory(%{create: create, input_fields: input_fields} = definition)
      when is_function(create, 2) and is_list(input_fields) do
    teardown = Map.get(definition, :teardown)
    ref_fields = Map.get(definition, :ref_fields)

    if teardown != nil and not is_function(teardown, 2) do
      raise ArgumentError, ~s(Factory "teardown" must be a 2-arity function if provided)
    end

    # Validate input_fields shape
    Enum.each(input_fields, fn field ->
      unless is_map(field) and Map.has_key?(field, :name) and Map.has_key?(field, :type) do
        raise ArgumentError,
              "Each input_field must be a map with :name and :type keys, got: #{inspect(field)}"
      end
    end)

    %{
      create: create,
      input_fields: input_fields,
      teardown: teardown,
      ref_fields: ref_fields
    }
  end

  def define_factory(%{create: _, input_fields: _}) do
    raise ArgumentError, ~s(Factory "create" must be a 2-arity function)
  end

  def define_factory(%{create: _}) do
    raise ArgumentError,
          ~s(Factory must declare `input_fields`. The SDK derives the discover schema from it.)
  end

  def define_factory(_) do
    raise ArgumentError,
          ~s(Factory definition must include "create" and "input_fields")
  end

  @doc """
  Validate a map of fields against the factory's input_fields definition.

  Strips unknown keys and checks that all required fields are present.
  Returns `{:ok, validated_map}` or `{:error, reason}`.
  """
  def validate_input(fields, input_fields) when is_map(fields) and is_list(input_fields) do
    known_names = MapSet.new(Enum.map(input_fields, fn f -> f.name end))

    # Strip unknown keys
    validated =
      fields
      |> Enum.filter(fn {k, _v} -> MapSet.member?(known_names, k) end)
      |> Map.new()

    # Check required fields
    missing =
      input_fields
      |> Enum.filter(fn f -> Map.get(f, :required, false) end)
      |> Enum.reject(fn f -> Map.has_key?(fields, f.name) end)
      |> Enum.map(fn f -> f.name end)

    if missing == [] do
      {:ok, validated}
    else
      {:error, "missing required fields: #{Enum.join(missing, ", ")}"}
    end
  end
end
