# frozen_string_literal: true

require "openssl"
require "base64"
require "json"
require "bigdecimal"
require "date"
require "time"

module Autonoma
  # Sign / verify the teardown token: a JWT-like token (header.payload.signature)
  # over HMAC-SHA256 - not a full JWT library, to avoid dependencies.
  #
  # The payload is { "refs" => <arbitrary JSON>, "testRunId" => <string>,
  # "environment" => <scenario name> }. refs is whatever a scenario's up
  # returned; it is signed at up and handed back to the scenario's down verbatim.
  # environment carries the scenario name so down can route to the right
  # teardown (named "environment" for wire/back-compat reasons).
  module Refs
    def self.sign_refs(payload, secret)
      header = base64url_encode(JSON.generate({ alg: "HS256", typ: "REFS" }))
      body = base64url_encode(JSON.generate(make_json_safe(payload)))
      signature = hmac_sign("#{header}.#{body}", secret)
      "#{header}.#{body}.#{signature}"
    end

    # Verify and decode a teardown token. Returns the payload hash or raises.
    def self.verify_refs(token, secret)
      parts = token.split(".")
      raise "malformed token" unless parts.length == 3

      header, body, signature = parts
      expected = hmac_sign("#{header}.#{body}", secret)

      raise "signature mismatch" unless Autonoma.secure_compare(expected, signature)

      JSON.parse(base64url_decode(body))
    end

    def self.base64url_encode(data)
      data = data.encode("UTF-8") if data.is_a?(String)
      Base64.urlsafe_encode64(data, padding: false)
    end

    def self.base64url_decode(data)
      padding = 4 - (data.length % 4)
      data += "=" * padding if padding != 4
      Base64.urlsafe_decode64(data)
    end

    def self.hmac_sign(data, secret)
      sig = OpenSSL::HMAC.digest("SHA256", secret, data)
      Base64.urlsafe_encode64(sig, padding: false)
    end

    # Recursively convert non-JSON-safe types (Time, DateTime, BigDecimal, ...)
    # to strings so JSON.generate does not raise. The Rails adapter reuses this
    # to serialize response bodies that may carry such values.
    def self.make_json_safe(obj)
      case obj
      when Hash
        obj.transform_values { |v| make_json_safe(v) }
      when Array
        obj.map { |v| make_json_safe(v) }
      when Time, DateTime
        obj.iso8601(3)
      when Date
        obj.iso8601
      when BigDecimal
        obj.to_s("F")
      when Symbol
        obj.to_s
      else
        obj
      end
    end

    private_class_method :base64url_encode, :base64url_decode, :hmac_sign
  end
end
