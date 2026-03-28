# =============================================================================
# Application Configuration
# =============================================================================

import Config

config :autonoma_example, AutonomaExample.Repo,
  username: "autonoma",
  password: "autonoma",
  hostname: "localhost",
  database: "autonoma_example",
  port: 5432

config :autonoma_example,
  ecto_repos: [AutonomaExample.Repo]

# Use Jason for JSON encoding (required by Phoenix and Autonoma)
config :phoenix, :json_library, Jason

import_config "#{config_env()}.exs"
