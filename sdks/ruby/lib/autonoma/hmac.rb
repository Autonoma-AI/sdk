# frozen_string_literal: true

require "openssl"

module Autonoma
  module Hmac
    # Sign a body string with a secret using HMAC-SHA256. Returns 64-char lowercase hex.
    def self.sign_body(body, secret)
      OpenSSL::HMAC.hexdigest("SHA256", secret, body)
    end

    # Verify a signature using constant-time comparison.
    def self.verify_signature(body, signature, secret)
      expected = sign_body(body, secret)
      return false unless expected.length == signature.length

      secure_compare(expected, signature)
    rescue StandardError
      false
    end

    # Constant-time string comparison to prevent timing attacks.
    def self.secure_compare(a, b)
      return false unless a.bytesize == b.bytesize

      l = a.unpack("C*")
      r = b.unpack("C*")
      result = 0
      l.each_with_index { |v, i| result |= v ^ r[i] }
      result.zero?
    end

    private_class_method :secure_compare
  end
end
