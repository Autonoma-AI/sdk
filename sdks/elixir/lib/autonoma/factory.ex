defmodule Autonoma.Factory do
  @moduledoc """
  Define a factory for creating entities via user code instead of raw SQL.

  The factory's `create` function receives pre-resolved fields (temp IDs replaced
  with real IDs) and must return at least the primary key field.
  """

  @doc """
  Validate and return a factory definition map.

  ## Options

    * `:create` (required) — a 2-arity function `(data, ctx) -> record`
    * `:teardown` (optional) — a 2-arity function `(record, ctx) -> any`

  ## Examples

      Autonoma.Factory.define_factory(%{
        create: fn data, ctx -> %{"id" => UUID.uuid4(), "name" => data["name"]} end,
        teardown: fn record, ctx -> MyApp.cleanup(record) end
      })
  """
  def define_factory(%{create: create} = definition) when is_function(create, 2) do
    teardown = Map.get(definition, :teardown)

    if teardown != nil && !is_function(teardown, 2) do
      raise ArgumentError, ~s(Factory "teardown" must be a 2-arity function if provided)
    end

    %{create: create, teardown: teardown}
  end

  def define_factory(%{create: _}) do
    raise ArgumentError, ~s(Factory "create" must be a 2-arity function)
  end

  def define_factory(_) do
    raise ArgumentError, ~s(Factory definition must include a "create" function)
  end
end
