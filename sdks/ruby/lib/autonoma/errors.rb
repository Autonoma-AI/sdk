# frozen_string_literal: true

module Autonoma
  # Base error carried across the wire with a stable code and HTTP status.
  class AutonomaError < StandardError
    attr_reader :code, :status

    def initialize(message, code, status)
      @code = code
      @status = status
      super(message)
    end
  end

  module Errors
    def self.invalid_signature
      AutonomaError.new("Invalid HMAC signature", "INVALID_SIGNATURE", 401)
    end

    def self.invalid_body(detail)
      AutonomaError.new("Invalid request body: #{detail}", "INVALID_BODY", 400)
    end

    def self.unknown_action(action)
      AutonomaError.new("Unknown action: #{action}", "UNKNOWN_ACTION", 400)
    end

    # Raised by up when the request names a scenario that is not registered.
    def self.unknown_environment(name)
      AutonomaError.new("Unknown environment: #{name}", "UNKNOWN_ENVIRONMENT", 400)
    end

    # Deprecated - the SDK no longer gates on production; this is never raised.
    # HMAC signing is the gate.
    def self.production_blocked
      AutonomaError.new("Environment factory is disabled", "PRODUCTION_BLOCKED", 404)
    end

    def self.invalid_teardown_token(detail)
      AutonomaError.new("Invalid teardown token: #{detail}", "INVALID_TEARDOWN_TOKEN", 403)
    end

    def self.same_secrets
      AutonomaError.new(
        "sharedSecret and signingSecret must be different. The shared secret is known by Autonoma; the signing secret must be private.",
        "SAME_SECRETS",
        500
      )
    end
  end
end
