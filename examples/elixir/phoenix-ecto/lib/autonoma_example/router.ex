defmodule AutonomaExample.Router do
  # ==========================================================================
  # Phoenix Router (Factory-driven)
  # ==========================================================================
  # Mounts the Autonoma Environment Factory endpoint. Every model the
  # dashboard can create has a registered factory with input_fields that
  # drive both validation and the discover schema. There is no SQL
  # introspection and no SQL fallback.

  use Phoenix.Router

  alias AutonomaExample.Repositories

  @autonoma_config %{
    # The column that scopes all models to a tenant — used to isolate test data
    scope_field: "organization_id",
    # Shared with Autonoma — verifies incoming requests via HMAC-SHA256
    shared_secret: System.get_env("AUTONOMA_SHARED_SECRET") || "my-shared-secret",
    # Private to your server — signs the refs token so teardown only deletes what was created
    signing_secret: System.get_env("AUTONOMA_SIGNING_SECRET") || "my-signing-secret",

    # Every model the dashboard can create needs a factory.
    # The factory's input_fields drives both validation and discover.
    factories: %{
      "Organization" => Autonoma.Factory.define_factory(%{
        input_fields: [
          %{name: "name", type: "string", required: true}
        ],
        create: fn data, _ctx -> Repositories.Organization.create(data) end,
        teardown: fn record, _ctx -> Repositories.Organization.delete(record["id"]) end
      }),

      "User" => Autonoma.Factory.define_factory(%{
        input_fields: [
          %{name: "email", type: "string", required: true},
          %{name: "name", type: "string", required: true},
          %{name: "organization_id", type: "string", required: true}
        ],
        create: fn data, _ctx -> Repositories.User.create(data) end
      })
    },

    # Called after `up` — returns credentials so Autonoma can make authenticated requests
    auth: fn _user, _context ->
      %{"headers" => %{"Authorization" => "Bearer test-token"}}
    end
  }

  forward "/api/autonoma", Autonoma.Plug.Handler, @autonoma_config
end
