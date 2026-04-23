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
    # Connects the SDK to your database through your ORM (Prisma, Drizzle, SQLAlchemy, etc.)
    executor: @executor,
    # The column that scopes all models to a tenant (e.g. organization_id). The SDK uses this to
    # isolate test data and ensure teardown only removes records belonging to the test run.
    scope_field: "organization_id",
    # Shared between your server and Autonoma. Used to verify incoming requests via HMAC-SHA256.
    shared_secret: System.get_env("AUTONOMA_SHARED_SECRET") || "my-shared-secret",
    # Private to your server only. Used to sign the refs token that tracks created records,
    # so teardown can only delete what was created.
    signing_secret: System.get_env("AUTONOMA_SIGNING_SECRET") || "my-signing-secret",

    # Custom create/teardown logic for models with business logic (password hashing, slug
    # generation, etc.). Models without a factory fall back to raw SQL INSERT.
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

    # Called after entity creation during `up`. Returns credentials (cookies, headers, tokens)
    # so Autonoma can make authenticated requests as the test user.
    auth: fn _user, _context ->
      %{"headers" => %{"Authorization" => "Bearer test-token"}}
    end
  }

  forward "/api/autonoma", Autonoma.Plug.Handler, @autonoma_config
end
