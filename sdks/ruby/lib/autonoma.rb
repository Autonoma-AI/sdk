# frozen_string_literal: true

require_relative "autonoma/errors"
require_relative "autonoma/types"
require_relative "autonoma/hmac"
require_relative "autonoma/refs"
require_relative "autonoma/graph"
require_relative "autonoma/fingerprint"
require_relative "autonoma/dialect"
require_relative "autonoma/introspect"
require_relative "autonoma/tree"
require_relative "autonoma/create"
require_relative "autonoma/teardown"
require_relative "autonoma/handler"

module Autonoma
  VERSION = "0.1.0"
end
