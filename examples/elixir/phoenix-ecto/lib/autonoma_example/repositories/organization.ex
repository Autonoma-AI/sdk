defmodule AutonomaExample.Repositories.Organization do
  # ==========================================================================
  # Organization Repository
  # ==========================================================================
  # Encapsulates business logic for creating organizations. In a real app,
  # this might handle slug generation, default settings, provisioning
  # external resources (Stripe customer, S3 bucket), audit logging, etc.

  alias AutonomaExample.Repo
  alias AutonomaExample.Schemas.Organization

  @doc """
  Create an organization with business logic applied.

  In production this would also:
    - Generate a URL-safe slug from the name
    - Create default settings / billing records
    - Provision external resources (Stripe, etc.)
  """
  def create(attrs) do
    %Organization{}
    |> Ecto.Changeset.cast(attrs, [:id, :name])
    |> Ecto.Changeset.validate_required([:name])
    |> Repo.insert!()
    |> to_map()
  end

  @doc """
  Delete an organization and clean up associated resources.

  In production this would also tear down external resources,
  cancel subscriptions, etc.
  """
  def delete(id) do
    Repo.get!(Organization, id)
    |> Repo.delete!()

    :ok
  end

  defp to_map(%Organization{} = org) do
    %{
      "id" => org.id,
      "name" => org.name
    }
  end
end
