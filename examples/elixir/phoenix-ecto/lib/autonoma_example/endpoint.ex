defmodule AutonomaExample.Endpoint do
  # ==========================================================================
  # Phoenix HTTP Endpoint
  # ==========================================================================
  # Configures the HTTP server and request pipeline.

  use Phoenix.Endpoint, otp_app: :autonoma_example

  # Note: We do NOT add Plug.Parsers here because the Autonoma handler
  # reads the raw request body itself for HMAC signature verification.
  # If you have other routes that need JSON parsing, add Plug.Parsers
  # in those specific pipelines instead.

  # Route requests to the router
  plug AutonomaExample.Router
end
