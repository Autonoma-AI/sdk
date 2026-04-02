defmodule AutonomaExample.Router do
  # ==========================================================================
  # Phoenix Router
  # ==========================================================================
  # Mounts the Autonoma Environment Factory endpoint.

  use Phoenix.Router

  alias AutonomaExample.Schemas.{Organization, User, Project, Task}

  # ---------------------------------------------------------------------------
  # Autonoma Endpoint
  # ---------------------------------------------------------------------------
  # The Autonoma SDK provides a Plug that handles the entire protocol:
  #   - discover: returns your schema metadata
  #   - up: creates test entities in FK order
  #   - down: tears down scoped test data
  #
  # We use `forward` to delegate all requests under /api/autonoma to the handler.

  # Create the Ecto adapter — it introspects your schemas automatically
  @adapter Autonoma.Ecto.Adapter.new(
    AutonomaExample.Repo,
    [Organization, User, Project, Task],
    scope_field: "organization_id"
  )

  @autonoma_config %{
    adapter: @adapter,
    # Shared secret — both you and Autonoma know this.
    shared_secret: System.get_env("AUTONOMA_SHARED_SECRET") || "my-shared-secret",
    # Signing secret — only you know this.
    signing_secret: System.get_env("AUTONOMA_SIGNING_SECRET") || "my-signing-secret"
  }

  forward "/api/autonoma", Autonoma.Plug.Handler, @autonoma_config
end
