defmodule AutonomaExample.Router do
  # ==========================================================================
  # Phoenix Router (Hybrid Factories + SQL)
  # ==========================================================================
  # Mounts the Autonoma Environment Factory endpoint using a hybrid approach:
  # factories for models with business logic (Organization, User), raw SQL
  # for simple models (Project, Task).

  use Phoenix.Router

  alias AutonomaExample.Repositories

  # ---------------------------------------------------------------------------
  # Autonoma Endpoint — Hybrid Factory Pattern
  # ---------------------------------------------------------------------------
  # The Autonoma SDK provides a Plug that handles the entire protocol:
  #   - discover: returns your schema metadata
  #   - up: creates test entities in FK order
  #   - down: tears down scoped test data
  #
  # Factories let you use your own repositories/services to create test data.
  # The SDK still handles scenario resolution, FK ordering, and teardown —
  # but delegates actual creation to your code for models that need it.
  #
  # Models WITHOUT a factory (Project, Task) fall back to raw SQL INSERT,
  # which works fine for simple tables without business logic.
  #
  # We use `forward` to delegate all requests under /api/autonoma to the handler.

  # Create the Ecto executor — wraps the Repo into a SQL executor
  @executor Autonoma.Ecto.Executor.ecto_executor(AutonomaExample.Repo)

  @autonoma_config %{
    executor: @executor,
    scope_field: "organization_id",
    # Shared secret — both you and Autonoma know this.
    shared_secret: System.get_env("AUTONOMA_SHARED_SECRET") || "my-shared-secret",
    # Signing secret — only you know this.
    signing_secret: System.get_env("AUTONOMA_SIGNING_SECRET") || "my-signing-secret",

    # ---------------------------------------------------------------------------
    # Factories — register models that have business logic
    # ---------------------------------------------------------------------------
    # Models with factories use your repository code for creation/teardown.
    # Models without factories (Project, Task) use raw SQL — zero setup needed.
    factories: %{
      # Organization: uses the repository which handles slug generation,
      # default settings, external service setup, etc.
      "Organization" => Autonoma.Factory.define_factory(%{
        create: fn data, _ctx ->
          Repositories.Organization.create(data)
        end,
        # Custom teardown — cleans up external resources (Stripe, S3, etc.)
        teardown: fn record, _ctx ->
          Repositories.Organization.delete(record["id"])
        end
      }),

      # User: uses the repository which handles password hashing,
      # email normalization, and other business logic.
      # No teardown defined — the SDK falls back to SQL DELETE.
      "User" => Autonoma.Factory.define_factory(%{
        create: fn data, _ctx ->
          Repositories.User.create(data)
        end
      })

      # Project and Task have no factories — they use raw SQL INSERT.
      # This is fine because they are simple tables with no business logic.
    },

    # Auth callback — called after entity creation during `up`.
    auth: fn _user, _context ->
      %{"headers" => %{"Authorization" => "Bearer test-token"}}
    end
  }

  forward "/api/autonoma", Autonoma.Plug.Handler, @autonoma_config
end
