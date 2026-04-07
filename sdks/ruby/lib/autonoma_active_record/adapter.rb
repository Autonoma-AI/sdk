# frozen_string_literal: true

require "active_record"

module AutonomaActiveRecord
  # ActiveRecord executor that implements the SQLExecutor interface.
  # Wraps an ActiveRecord connection for use with the Autonoma SDK.
  class Executor
    def initialize(connection = nil)
      @connection = connection
    end

    def connection
      @connection || ActiveRecord::Base.connection
    end

    # Execute a SQL query with parameterized values, returning rows as hashes.
    def query(sql, params = [])
      conn = connection

      if params.empty?
        result = conn.exec_query(sql)
      else
        binds = params.map { |v| build_bind(v) }
        # Normalize placeholders to $1, $2, ... for ActiveRecord bind support
        normalized_sql = normalize_placeholders(sql)
        result = conn.exec_query(normalized_sql, "SQL", binds)
      end

      result.to_a
    end

    # Run a block within a database transaction.
    def transaction
      connection.transaction do
        yield self
      end
    end

    private

    # Convert ? placeholders to $1, $2, ... for ActiveRecord.
    # $N placeholders are passed through as-is.
    def normalize_placeholders(sql)
      idx = 0
      sql.gsub("?") do
        idx += 1
        "$#{idx}"
      end
    end

    def build_bind(value)
      ActiveRecord::Relation::QueryAttribute.new("", value, ActiveRecord::Type::Value.new)
    end
  end

  # Create an Autonoma HandlerConfig using ActiveRecord.
  def self.create_config(scope_field:, shared_secret:, signing_secret:, connection: nil, **options)
    executor = Executor.new(connection)
    sdk = (options.delete(:sdk) || {}).merge("orm" => "active_record")

    Autonoma::HandlerConfig.new(
      executor: executor,
      scope_field: scope_field,
      shared_secret: shared_secret,
      signing_secret: signing_secret,
      sdk: sdk,
      **options
    )
  end
end
