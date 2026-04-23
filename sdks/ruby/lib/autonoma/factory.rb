# frozen_string_literal: true

require_relative "types"

module Autonoma
  module Factory
    # Define a factory for creating entities via user code instead of raw SQL.
    # The factory's `create` callable receives pre-resolved fields (temp IDs replaced
    # with real IDs) and must return at least the primary key field.
    def self.define_factory(create:, teardown: nil)
      raise ArgumentError, 'Factory definition must include a callable "create"' unless create.respond_to?(:call)

      if teardown && !teardown.respond_to?(:call)
        raise ArgumentError, 'Factory "teardown" must be callable if provided'
      end

      FactoryDefinition.new(create: create, teardown: teardown)
    end
  end
end
