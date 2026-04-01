defmodule AutonomaExample.Schemas.Project do
  # ==========================================================================
  # Project Schema
  # ==========================================================================
  # A project belongs to an Organization.

  use Ecto.Schema

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "projects" do
    field :name, :string

    belongs_to :organization, AutonomaExample.Schemas.Organization

    has_many :tasks, AutonomaExample.Schemas.Task

    timestamps()
  end
end
