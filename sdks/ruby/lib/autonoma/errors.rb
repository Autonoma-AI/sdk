# frozen_string_literal: true

module Autonoma
  class AutonomaError < StandardError
    attr_reader :message, :code, :status

    def initialize(message, code, status)
      @message = message
      @code = code
      @status = status
      super(message)
    end
  end

  module Errors
    def self.invalid_signature
      AutonomaError.new("Invalid signature", "INVALID_SIGNATURE", 401)
    end

    def self.invalid_body(detail)
      AutonomaError.new("Invalid body: #{detail}", "INVALID_BODY", 400)
    end

    def self.unknown_action(action)
      AutonomaError.new("Unknown action: #{action}", "UNKNOWN_ACTION", 400)
    end

    # Deprecated - the SDK no longer gates on production; this is never raised.
    def self.production_blocked
      AutonomaError.new("Environment factory is disabled", "PRODUCTION_BLOCKED", 404)
    end

    def self.invalid_refs_token(detail)
      AutonomaError.new("Invalid refs token: #{detail}", "INVALID_REFS_TOKEN", 403)
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
