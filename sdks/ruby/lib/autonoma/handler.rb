# frozen_string_literal: true

require "json"
require "securerandom"

require_relative "hmac"
require_relative "refs"
require_relative "errors"
require_relative "types"

module Autonoma
  # Request routing for discover / up / down protocol actions (Scenario v2).
  #
  # discover lists the registered scenarios; up looks a scenario up by name,
  # runs its free-form up, signs a teardown token carrying the scenario name,
  # and responds; down recovers the scenario name from the verified token and
  # routes to that scenario's down. There is no create-graph interpreter and no
  # factory-derived discover schema.
  module Handler
    PROTOCOL_VERSION = begin
      File.read(File.expand_path("../../../../protocol/version.txt", __dir__)).strip
    rescue Errno::ENOENT, Errno::EACCES
      "2.0"
    end

    DEFAULT_EXPIRES_IN_SECONDS = 3600

    def self.handle_request(config, req)
      if config.shared_secret == config.signing_secret
        raise Errors.same_secrets
      end

      signature = req.headers["x-signature"] || req.headers["X-Signature"] || ""
      unless Hmac.verify_signature(req.body, signature, config.shared_secret)
        raise Errors.invalid_signature
      end

      begin
        body = JSON.parse(req.body)
      rescue JSON::ParserError
        raise Errors.invalid_body("invalid JSON")
      end

      action = body["action"]
      if action.nil? || action.to_s.empty?
        raise Errors.invalid_body('missing action. expected one of "discover", "up" or "down"')
      end

      case action
      when "discover"
        handle_discover(config)
      when "up"
        handle_up(config, body)
      when "down"
        handle_down(config, body)
      else
        raise Errors.unknown_action(action)
      end
    rescue AutonomaError => e
      HandlerResponse.new(status: e.status, body: { "error" => e.message, "code" => e.code })
    rescue StandardError => e
      HandlerResponse.new(status: 500, body: { "error" => e.message, "code" => "INTERNAL_ERROR" })
    end

    # -----------------------------------------------------------------------
    # discover
    # -----------------------------------------------------------------------

    def self.handle_discover(config)
      scenarios = (config.scenarios || []).map do |s|
        { "name" => s.name, "description" => s.description }
      end
      HandlerResponse.new(
        status: 200,
        body: build_sdk_meta(config).merge("scenarios" => scenarios)
      )
    end

    # -----------------------------------------------------------------------
    # up
    # -----------------------------------------------------------------------

    def self.handle_up(config, body)
      name = read_scenario_name(body)
      raise Errors.invalid_body('missing "scenario.name" in request body') if name.nil? || name.empty?

      scenario = find_scenario(config, name)
      raise Errors.unknown_environment(name) if scenario.nil?

      test_run_id = string_or_nil(body["testRunId"]) || SecureRandom.uuid

      result = scenario.up.call(ScenarioUpContext.new(test_run_id: test_run_id))
      result = {} if result.nil?

      auth = result_field(result, :auth)
      teardown = result_field(result, :teardown)

      teardown_token = Refs.sign_refs(
        { "refs" => teardown || {}, "testRunId" => test_run_id, "environment" => name },
        config.signing_secret
      )

      expires = config.expires_in_seconds || DEFAULT_EXPIRES_IN_SECONDS

      resp = build_sdk_meta(config)
      resp["auth"] = auth unless auth.nil?
      resp["teardownToken"] = teardown_token
      resp["expiresInSeconds"] = expires

      HandlerResponse.new(status: 200, body: resp)
    end

    # -----------------------------------------------------------------------
    # down
    # -----------------------------------------------------------------------

    def self.handle_down(config, body)
      teardown_token = string_or_nil(body["teardownToken"])
      raise Errors.invalid_body("missing teardownToken") if teardown_token.nil? || teardown_token.empty?

      begin
        payload = Refs.verify_refs(teardown_token, config.signing_secret)
      rescue StandardError => e
        raise Errors.invalid_teardown_token(e.message)
      end

      teardown = payload["refs"] || {}
      test_run_id = payload["testRunId"] || ""
      # The verified token is authoritative for routing; any scenario name on
      # the request body is ignored.
      name = payload["environment"] || ""

      unless name.empty?
        scenario = find_scenario(config, name)
        if scenario && scenario.down
          scenario.down.call(
            ScenarioDownContext.new(name: name, teardown: teardown, test_run_id: test_run_id)
          )
        end
      end

      HandlerResponse.new(status: 200, body: build_sdk_meta(config).merge("ok" => true))
    end

    # -----------------------------------------------------------------------
    # helpers
    # -----------------------------------------------------------------------

    def self.build_sdk_meta(config)
      sdk = config.sdk || {}
      {
        "version" => PROTOCOL_VERSION,
        "sdk" => {
          "language" => "ruby",
          "orm" => sdk["orm"] || sdk[:orm] || "unknown",
          "server" => sdk["server"] || sdk[:server] || "unknown"
        }
      }
    end

    def self.find_scenario(config, name)
      (config.scenarios || []).find { |s| s.name == name }
    end

    # Read body.scenario.name from an untrusted JSON body.
    def self.read_scenario_name(body)
      scenario = body["scenario"]
      return nil unless scenario.is_a?(Hash)

      name = scenario["name"]
      name.is_a?(String) ? name : nil
    end

    def self.string_or_nil(value)
      value.is_a?(String) ? value : nil
    end

    # Read a field from a scenario up result that may be a ScenarioUpResult
    # struct or a plain Hash keyed by symbols or strings.
    def self.result_field(result, key)
      if result.is_a?(Hash)
        result[key].nil? ? result[key.to_s] : result[key]
      elsif result.respond_to?(key)
        result.public_send(key)
      end
    end

    private_class_method :build_sdk_meta, :handle_discover, :handle_up,
                         :handle_down, :find_scenario, :read_scenario_name,
                         :string_or_nil, :result_field
  end
end
