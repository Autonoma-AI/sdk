# frozen_string_literal: true

require "autonoma"

module AutonomaRails
  # Rails controller mixin for handling Autonoma protocol requests.
  #
  # Usage in a Rails controller:
  #
  #   class AutonomaController < ApplicationController
  #     include AutonomaRails::Handler
  #
  #     skip_before_action :verify_authenticity_token
  #
  #     def handle
  #       autonoma_handle(autonoma_config)
  #     end
  #
  #     private
  #
  #     def autonoma_config
  #       @autonoma_config ||= AutonomaActiveRecord.create_config(
  #         scope_field: "organizationId",
  #         shared_secret: ENV["AUTONOMA_SHARED_SECRET"],
  #         signing_secret: ENV["AUTONOMA_SIGNING_SECRET"]
  #       )
  #     end
  #   end
  #
  module Handler
    def autonoma_handle(config)
      enriched = config.dup
      sdk = (enriched.sdk || {}).merge("server" => "rails")
      enriched.sdk = sdk

      body_str = request.raw_post
      headers = request.headers.to_h
        .select { |k, _| k.is_a?(String) }
        .transform_keys(&:downcase)

      req = Autonoma::HandlerRequest.new(body: body_str, headers: headers)
      result = Autonoma::Handler.handle_request(enriched, req)

      render json: result.body, status: result.status
    end
  end

  # Rack middleware alternative for mounting Autonoma as a Rack app.
  class Middleware
    def initialize(app, config, path: "/api/autonoma")
      @app = app
      @config = enrich_config(config)
      @path = path
    end

    def call(env)
      unless env["PATH_INFO"] == @path && env["REQUEST_METHOD"] == "POST"
        return @app.call(env)
      end

      body_str = env["rack.input"].read
      env["rack.input"].rewind

      headers = {}
      env.each do |key, value|
        if key.start_with?("HTTP_")
          header_name = key[5..].downcase.tr("_", "-")
          headers[header_name] = value
        end
      end
      headers["content-type"] = env["CONTENT_TYPE"] if env["CONTENT_TYPE"]

      req = Autonoma::HandlerRequest.new(body: body_str, headers: headers)
      result = Autonoma::Handler.handle_request(@config, req)

      [
        result.status,
        { "Content-Type" => "application/json" },
        [JSON.generate(result.body)]
      ]
    end

    private

    def enrich_config(config)
      enriched = config.dup
      sdk = (enriched.sdk || {}).merge("server" => "rails")
      enriched.sdk = sdk
      enriched
    end
  end
end
