defmodule AutonomaExample.Repositories.User do
  # ==========================================================================
  # User Repository
  # ==========================================================================
  # Encapsulates business logic for creating users. Handles password hashing,
  # email normalization, and other domain-specific concerns that raw SQL
  # cannot replicate.

  alias AutonomaExample.Repo
  alias AutonomaExample.Schemas.User

  @doc """
  Create a user with business logic applied.

  - Normalizes the email to lowercase
  - Hashes the password with SHA-256 (use bcrypt/argon2 in production!)
  """
  def create(attrs) do
    # Normalize email to lowercase — business logic that raw SQL skips
    email = attrs |> Map.get("email", "") |> String.downcase()

    # Hash the password — in production, use Bcrypt or Argon2 instead
    password = attrs |> Map.get("password", "default-password")
    hashed_password = :crypto.hash(:sha256, password) |> Base.encode16(case: :lower)

    %User{}
    |> Ecto.Changeset.cast(
      %{
        id: Map.get(attrs, "id"),
        name: Map.get(attrs, "name"),
        email: email,
        organization_id: Map.get(attrs, "organization_id")
      },
      [:id, :name, :email, :organization_id]
    )
    |> Ecto.Changeset.put_change(:email, email)
    |> Ecto.Changeset.validate_required([:name, :email, :organization_id])
    |> Repo.insert!()
    |> to_map(hashed_password)
  end

  defp to_map(%User{} = user, hashed_password) do
    %{
      "id" => user.id,
      "email" => user.email,
      "name" => user.name,
      "organization_id" => user.organization_id,
      "hashed_password" => hashed_password
    }
  end
end
