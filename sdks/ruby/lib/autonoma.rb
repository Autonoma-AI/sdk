# frozen_string_literal: true

require_relative "autonoma/errors"
require_relative "autonoma/types"
require_relative "autonoma/hmac"
require_relative "autonoma/refs"
require_relative "autonoma/graph"
require_relative "autonoma/fingerprint"
require_relative "autonoma/payload_topo"
require_relative "autonoma/schema"
require_relative "autonoma/factory"
require_relative "autonoma/handler"

module Autonoma
  VERSION = "0.2.0"
end
