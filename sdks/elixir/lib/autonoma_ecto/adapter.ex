defmodule Autonoma.Ecto.Adapter do
  @moduledoc """
  Ecto implementation of the Autonoma.Adapter behaviour.
  Requires a repo module and a list of schema modules to introspect.
  """

  @behaviour Autonoma.Adapter

  defstruct [:repo, :schemas, :scope_field]

  def new(repo, schemas, opts \\ []) do
    %__MODULE__{
      repo: repo,
      schemas: schemas,
      scope_field: Keyword.get(opts, :scope_field, "testRunId")
    }
  end

  @impl true
  def get_schema do
    # Placeholder — will be populated by introspect.ex
    %{"models" => [], "edges" => [], "relations" => [], "scopeField" => "testRunId"}
  end

  @impl true
  def create_entities(_spec, _context) do
    {:ok, %{}}
  end

  @impl true
  def teardown(_scope_value, _refs) do
    :ok
  end
end
