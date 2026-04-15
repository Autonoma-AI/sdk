# =============================================================================
# Autonoma SDK — Rails + ActiveRecord Example (Hybrid Factories + SQL)
# =============================================================================
# This example shows how to use factories for models with business logic
# (Organization, User) while letting the SDK handle simpler models (Project,
# Task) via raw SQL. This "hybrid" approach gives you the best of both worlds:
# correct business logic where it matters, zero setup where it doesn't.

require "autonoma_active_record"
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
    @autonoma_config ||= AutonomaActiveRecord.create_config(
      # The column that scopes all models to a tenant (e.g. organization_id). The SDK uses this to
      # isolate test data and ensure teardown only removes records belonging to the test run.
      scope_field: "organization_id",
      # Shared between your server and Autonoma. Used to verify incoming requests via HMAC-SHA256.
      shared_secret: ENV.fetch("AUTONOMA_SHARED_SECRET", "my-shared-secret"),
      # Private to your server only. Used to sign the refs token that tracks created records,
      # so teardown can only delete what was created.
      signing_secret: ENV.fetch("AUTONOMA_SIGNING_SECRET", "my-signing-secret"),

      # Custom create/teardown logic for models with business logic (password hashing, slug
      # generation, etc.). Models without a factory fall back to raw SQL INSERT.
      factories: {
        # Organization: uses the repository which handles slug generation,
        # default settings, external service setup, etc.
        "Organization" => Autonoma::Factory.define_factory(
          create: ->(data, _ctx) { OrganizationRepository.create(data) },
          teardown: ->(record, _ctx) { OrganizationRepository.delete(record["id"]) }
        ),

        # User: uses the repository which handles password hashing,
        # email normalization, and other business logic.
        # No teardown defined -- the SDK falls back to SQL DELETE.
        "User" => Autonoma::Factory.define_factory(
          create: ->(data, _ctx) { UserRepository.create(data) }
        ),

        # Project and Task have no factories -- they use raw SQL INSERT.
        # This is fine because they're simple tables with no business logic.
      },

      # Called after entity creation during `up`. Returns credentials (cookies, headers, tokens)
      # so Autonoma can make authenticated requests as the test user.
      auth: ->(_user, _context) {
        { "headers" => { "Authorization" => "Bearer test-token" } }
      }
    )
  end
end
