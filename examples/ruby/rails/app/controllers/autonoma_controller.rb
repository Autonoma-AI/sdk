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
      scope_field: "organization_id",
      shared_secret: ENV.fetch("AUTONOMA_SHARED_SECRET", "my-shared-secret"),
      signing_secret: ENV.fetch("AUTONOMA_SIGNING_SECRET", "my-signing-secret"),

      # -----------------------------------------------------------------------
      # Factories: register models that have business logic
      # -----------------------------------------------------------------------
      # Factories let you use your own repositories/services to create test data.
      # The SDK still handles scenario resolution, FK ordering, and teardown --
      # but delegates actual creation to your code for models that need it.
      #
      # Models WITHOUT a factory (Project, Task) fall back to raw SQL INSERT,
      # which works fine for simple tables without business logic.
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

      auth: ->(_user, _context) {
        { "headers" => { "Authorization" => "Bearer test-token" } }
      }
    )
  end
end
