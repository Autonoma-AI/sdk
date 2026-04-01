defmodule Autonoma.Adapter do
  @moduledoc """
  Behaviour for ORM adapters. Implement this for Ecto, or any other ORM.
  """

  @callback get_schema() :: map()

  @callback create_entities(spec :: map(), context :: map()) ::
              {:ok, map()} | {:error, term()}

  @callback teardown(scope_value :: String.t(), refs :: map() | nil) ::
              :ok | {:error, term()}

  @callback update_entity(model :: String.t(), id :: String.t(), fields :: map()) ::
              :ok | {:error, term()}

  @optional_callbacks [update_entity: 3]
end
