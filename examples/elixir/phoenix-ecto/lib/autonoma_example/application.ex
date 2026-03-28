defmodule AutonomaExample.Application do
  # ==========================================================================
  # Application Supervision Tree
  # ==========================================================================
  # Starts the Ecto repo and Phoenix endpoint under a supervisor.

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      # Start the Ecto repository (database connection pool)
      AutonomaExample.Repo,
      # Start the Phoenix endpoint (HTTP server)
      AutonomaExample.Endpoint
    ]

    opts = [strategy: :one_for_one, name: AutonomaExample.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
