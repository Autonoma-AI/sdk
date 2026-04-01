import Config

# Dev-specific database config
config :autonoma_example, AutonomaExample.Repo,
  show_sensitive_data_on_connection_error: true,
  pool_size: 10

# Phoenix endpoint config
config :autonoma_example, AutonomaExample.Endpoint,
  http: [port: 4000],
  debug_errors: true,
  check_origin: false
