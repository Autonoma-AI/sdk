defmodule AutonomaExample.Schemas.User do
  # ==========================================================================
  # User Schema
  # ==========================================================================
  # A user belongs to an Organization.

  use Ecto.Schema

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "users" do
    field :email, :string
    field :name, :string

    # Every model references the Organization (scope field)
    belongs_to :organization, AutonomaExample.Schemas.Organization

    has_many :tasks, AutonomaExample.Schemas.Task, foreign_key: :assignee_id

    timestamps()
  end
end
