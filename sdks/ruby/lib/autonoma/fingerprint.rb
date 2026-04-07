# frozen_string_literal: true

require "openssl"
require "json"

module Autonoma
  module Fingerprint
    # Compute a 16-char hex fingerprint of any JSON-serializable value.
    def self.fingerprint(value)
      normalized = sort_keys(value)
      json_str = JSON.generate(normalized)
      OpenSSL::Digest::SHA256.hexdigest(json_str)[0, 16]
    end

    def self.sort_keys(obj)
      case obj
      when Hash
        obj.sort.to_h.transform_values { |v| sort_keys(v) }
      when Array
        obj.map { |v| sort_keys(v) }
      else
        obj
      end
    end

    private_class_method :sort_keys
  end
end
