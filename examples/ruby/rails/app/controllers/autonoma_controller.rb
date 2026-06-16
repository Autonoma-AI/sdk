# =============================================================================
# Autonoma SDK — Rails Example (Factory-driven)
# =============================================================================
# The SDK is factory-driven: every model the dashboard can create has a
# registered factory whose input_fields drives both validation and the
# discover schema. There is no SQL introspection, no ActiveRecord executor,
# and no SQL fallback — your factories call whatever services your app has.

require "autonoma"
require "autonoma_rails"
require_relative "../repositories/organization_repository"
require_relative "../repositories/user_repository"

class AutonomaController < ApplicationController
  include AutonomaRails::Handler

  def handle
    autonoma_handle(autonoma_config)
  end

  private

  def autonoma_config
    @autonoma_config ||= Autonoma::Types::HandlerConfig.new(
      # The column that scopes all models to a tenant — used to isolate test data
      scope_field: "organization_id",
      # Shared with Autonoma — verifies incoming requests via HMAC-SHA256
      shared_secret: ENV.fetch("AUTONOMA_SHARED_SECRET", "my-shared-secret"),
      # Private to your server — signs the refs token so teardown only deletes what was created
      signing_secret: ENV.fetch("AUTONOMA_SIGNING_SECRET", "my-signing-secret"),

      # Required: the endpoint returns 404 unless this is true. The SDK never
      # inspects RAILS_ENV/RACK_ENV — tie it to your own condition to keep it off
      # in prod, e.g. allow_production: !Rails.env.production?.
      allow_production: true,

      # Every model the dashboard can create needs a factory.
      # The factory's input_fields drives both validation and discover.
      factories: {
        "Organization" => Autonoma::Factory.define_factory(
          input_fields: [
            { name: "name", type: "string", required: true }
          ],
          create: ->(data, _ctx) { OrganizationRepository.create(data) },
          teardown: ->(record, _ctx) { OrganizationRepository.delete(record["id"]) }
        ),

        # data is validated against input_fields before reaching this lambda
        "User" => Autonoma::Factory.define_factory(
          input_fields: [
            { name: "email", type: "string", required: true },
            { name: "name", type: "string", required: true },
            { name: "organization_id", type: "string", required: true }
          ],
          create: ->(data, _ctx) { UserRepository.create(data) }
        ),
      },

      # Called after `up` — returns credentials so Autonoma can make authenticated requests
      auth: ->(_user, _context) {
        { "headers" => { "Authorization" => "Bearer test-token" } }
      }
    )
  end
end
