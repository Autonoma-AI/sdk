# frozen_string_literal: true

require_relative "types"

module Autonoma
  module Factory
    # Define a factory for creating entities.
    #
    # input_fields is required: an array of hashes {name:, type:, required:}
    # where type is one of 'string', 'integer', 'number', 'boolean',
    # 'timestamp', 'date', 'uuid', 'json'.
    #
    # The factory's create callable receives a validated Hash and a
    # FactoryContext, and must return a Hash with at least an "id" key.
    #
    # teardown is optional; without it the SDK has no way to remove rows
    # the factory created.
    def self.define_factory(create:, input_fields:, teardown: nil)
      raise ArgumentError, 'Factory definition must include a callable "create"' unless create.respond_to?(:call)

      if teardown && !teardown.respond_to?(:call)
        raise ArgumentError, 'Factory "teardown" must be callable if provided'
      end

      if input_fields.nil? || !input_fields.is_a?(Array) || input_fields.empty?
        raise ArgumentError,
              "Factory must declare `input_fields: [...]`. The SDK derives the discover " \
              "schema from it; there is no automatic fallback."
      end

      FactoryDefinition.new(create: create, teardown: teardown, input_fields: input_fields)
    end
  end
end
