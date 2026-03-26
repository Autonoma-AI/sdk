defmodule Autonoma.TestSchemas.Organization do
  use Ecto.Schema

  @primary_key {:id, :string, autogenerate: false}
  schema "organizations" do
    field :name, :string
    has_many :users, Autonoma.TestSchemas.User
    has_many :applications, Autonoma.TestSchemas.Application
  end
end

defmodule Autonoma.TestSchemas.User do
  use Ecto.Schema

  @primary_key {:id, :string, autogenerate: false}
  schema "users" do
    field :email, :string
    belongs_to :organization, Autonoma.TestSchemas.Organization, type: :string
  end
end

defmodule Autonoma.TestSchemas.Application do
  use Ecto.Schema

  @primary_key {:id, :string, autogenerate: false}
  schema "applications" do
    field :name, :string
    belongs_to :organization, Autonoma.TestSchemas.Organization, type: :string
  end
end
