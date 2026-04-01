defmodule AutonomaExample.Schemas.Organization do
  # ==========================================================================
  # Organization Schema
  # ==========================================================================
  # The root tenant model — everything belongs to an Organization.
  # This is the "scope" entity: Autonoma uses `organization_id` to isolate
  # test data across test runs.

  use Ecto.Schema

  @primary_key {:id, :binary_id, autogenerate: true}

  schema "organizations" do
    field :name, :string

    # Relations: an Organization has many Users and Projects
    has_many :users, AutonomaExample.Schemas.User
    has_many :projects, AutonomaExample.Schemas.Project

    timestamps()
  end
end
