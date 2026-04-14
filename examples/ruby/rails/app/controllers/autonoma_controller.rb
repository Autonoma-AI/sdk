require "autonoma_active_record"
require "autonoma_rails"

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
      auth: ->(user, _context) {
        { "headers" => { "Authorization" => "Bearer test-token" } }
      }
    )
  end
end
