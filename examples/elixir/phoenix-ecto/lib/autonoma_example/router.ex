defmodule AutonomaExample.Router do
  # ==========================================================================
  # Phoenix Router
  # ==========================================================================
  # Mounts the Autonoma Environment Factory endpoint.

  use Phoenix.Router

  # ---------------------------------------------------------------------------
  # Autonoma Endpoint
  # ---------------------------------------------------------------------------
  # The Autonoma SDK provides a Plug that handles the entire protocol:
  #   - discover: returns your schema metadata
  #   - up: creates test entities in FK order
  #   - down: tears down scoped test data
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
    # Auth callback — called after entity creation during `up`.
    auth: fn _user, _context ->
      %{"headers" => %{"Authorization" => "Bearer test-token"}}
    end
  }

  forward "/api/autonoma", Autonoma.Plug.Handler, @autonoma_config
end
