defmodule AutonomaExample.Schemas.Task do
  # ==========================================================================
  # Task Schema
  # ==========================================================================
  # A task belongs to a Project and is assigned to a User.
  # Demonstrates a model with multiple foreign keys.

  use Ecto.Schema

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "tasks" do
    field :title, :string
    field :status, :string, default: "todo"

    belongs_to :organization, AutonomaExample.Schemas.Organization
    belongs_to :project, AutonomaExample.Schemas.Project
    belongs_to :assignee, AutonomaExample.Schemas.User

    timestamps()
  end
end
