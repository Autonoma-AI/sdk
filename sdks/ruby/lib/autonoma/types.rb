# frozen_string_literal: true

module Autonoma
  # ---------------------------------------------------------------------------
  # Scenario authoring surface (Scenario v2)
  # ---------------------------------------------------------------------------

  # Context passed to a scenario's up. Seed the uniqueness helpers
  # (Unique.unique_email, Unique.unique_slug, ...) from test_run_id so values
  # are unique per run yet reproducible between up and down.
  ScenarioUpContext = Struct.new(:test_run_id, keyword_init: true)

  # What a scenario's up returns. Every field is optional; a scenario may also
  # return a plain Hash with :auth / :teardown keys.
  ScenarioUpResult = Struct.new(:auth, :teardown, keyword_init: true)

  # Context passed to a scenario's down.
  ScenarioDownContext = Struct.new(:name, :teardown, :test_run_id, keyword_init: true)

  # A named scenario. up provisions an isolated environment a test needs; the
  # optional down tears it back down. Register scenarios on
  # HandlerConfig#scenarios. Build one with Scenario.define_scenario.
  ScenarioDefinition = Struct.new(:name, :description, :up, :down, keyword_init: true)

  # ---------------------------------------------------------------------------
  # Optional factory library (not wired to the wire protocol in v2)
  # ---------------------------------------------------------------------------

  # Context passed to factory create/teardown callables. Factories are an
  # optional helper a scenario's up/down may use to create and tear down
  # entities through the app's real logic; the SDK does not ship a database.
  FactoryContext = Struct.new(:refs, :scenario_name, :test_run_id, keyword_init: true)

  # Factory definition - build one with Factory.define_factory.
  FactoryDefinition = Struct.new(:create, :teardown, :input_fields, keyword_init: true)

  # ---------------------------------------------------------------------------
  # Handler config + wire types
  # ---------------------------------------------------------------------------

  HandlerRequest = Struct.new(:body, :headers, keyword_init: true) do
    def initialize(body:, headers: {})
      super
    end
  end

  HandlerResponse = Struct.new(:status, :body, keyword_init: true)

  HandlerConfig = Struct.new(
    :shared_secret,
    :signing_secret,
    :scenarios,
    :expires_in_seconds,
    # Deprecated - ignored; the endpoint is always enabled and HMAC signing is
    # the gate. Gate manually in your handler for your own production.
    :allow_production,
    :sdk,
    keyword_init: true
  ) do
    def initialize(shared_secret:, signing_secret:, scenarios: [],
                   expires_in_seconds: nil, allow_production: false, sdk: nil)
      if allow_production
        warn "[autonoma] allow_production is deprecated and ignored - the endpoint is always enabled"
      end
      super
    end
  end
end
