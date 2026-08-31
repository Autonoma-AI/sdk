defmodule Autonoma.Types do
  @moduledoc """
  Type definitions for the Autonoma SDK (Scenario v2).

  A host registers named scenarios with `Autonoma.Scenario.define_scenario/1`.
  The platform calls `up` with only a scenario name + `testRunId`; the scenario's
  `up` runs free-form code and returns optional `auth` / `teardown`. The SDK owns
  the envelope: `teardownToken` signing, expiry defaults, and the protocol
  `version` field.
  """

  # ---------------------------------------------------------------------------
  # Auth
  # ---------------------------------------------------------------------------

  @type auth_cookie :: %{
          required(:name) => String.t(),
          required(:value) => String.t(),
          optional(:http_only) => boolean(),
          optional(:same_site) => String.t(),
          optional(:path) => String.t(),
          optional(:domain) => String.t(),
          optional(:secure) => boolean(),
          optional(:max_age) => integer()
        }

  @type auth_result :: %{
          optional(:cookies) => [auth_cookie()],
          optional(:headers) => %{String.t() => String.t()},
          optional(:credentials) => %{String.t() => String.t()}
        }

  # ---------------------------------------------------------------------------
  # Handler config + wire types
  # ---------------------------------------------------------------------------

  @type handler_config :: %{
          required(:shared_secret) => String.t(),
          required(:signing_secret) => String.t(),
          optional(:scenarios) => [Autonoma.Scenario.t()],
          optional(:expires_in_seconds) => integer(),
          # Deprecated - ignored; the endpoint is always enabled and HMAC signing
          # is the gate. Gate manually in your handler for your own production.
          optional(:allow_production) => boolean(),
          optional(:sdk) => map()
        }

  @type handler_request :: %{
          body: String.t(),
          headers: map()
        }

  @type handler_response :: %{
          status: integer(),
          body: map()
        }
end
