# frozen_string_literal: true

require_relative "types"

module Autonoma
  # Define a named scenario.
  #
  # A scenario's up is free-form code (loops, conditionals, real API calls) that
  # provisions an isolated environment and returns the auth/teardown a test run
  # needs. An omitted down is a no-op. Register scenarios with
  # HandlerConfig.new(..., scenarios: [Autonoma::Scenario.define_scenario(...)]).
  #
  # up and down are callables (lambdas/procs); up may also be passed as a block.
  # up receives a ScenarioUpContext and returns either a ScenarioUpResult or a
  # plain Hash with :auth / :teardown keys. down receives a
  # ScenarioDownContext.
  #
  # @example
  #   Autonoma::Scenario.define_scenario(
  #     name: "single-user",
  #     description: "One verified user in a fresh org",
  #     up: ->(ctx) {
  #       email = Autonoma::Unique.unique_email(ctx.test_run_id)
  #       user = App::User.create!(email: email)
  #       {
  #         auth: { "headers" => { "Authorization" => "Bearer #{user.token}" } },
  #         teardown: { "userId" => user.id }
  #       }
  #     },
  #     down: ->(ctx) { App::User.delete(ctx.teardown["userId"]) }
  #   )
  module Scenario
    def self.define_scenario(name:, description:, up: nil, down: nil, &block)
      up_callable = up || block

      unless name.is_a?(String) && !name.empty?
        raise ArgumentError, 'Scenario "name" must be a non-empty string'
      end
      unless description.is_a?(String)
        raise ArgumentError, 'Scenario "description" must be a string'
      end
      unless up_callable.respond_to?(:call)
        raise ArgumentError, 'Scenario "up" must be callable (a lambda, proc, or block)'
      end
      if down && !down.respond_to?(:call)
        raise ArgumentError, 'Scenario "down" must be callable if provided'
      end

      ScenarioDefinition.new(name: name, description: description, up: up_callable, down: down)
    end
  end
end
