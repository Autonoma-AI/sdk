# frozen_string_literal: true

require "digest"

module Autonoma
  # Deterministic uniqueness helpers seeded from test_run_id. A scenario's data
  # needs stable keys across runs but unique values per run (unique emails, org
  # slugs, ids). These derive that uniqueness from (test_run_id, ...parts): the
  # same inputs always produce the same output within a run, so a scenario's up
  # and a later down compute identical values without storing them.
  #
  # The recipe is sha256(test_run_id + (" " + part) for each part), hex-encoded,
  # truncated to the first 12 chars - and MUST match the other language SDKs
  # byte-for-byte for cross-language conformance.
  module Unique
    TOKEN_LENGTH = 12

    SLUG_NON_ALNUM = /[^a-z0-9]+/.freeze
    SLUG_TRIM_HYPHENS = /\A-+|-+\z/.freeze

    # A short hex token, deterministic per (test_run_id, ...parts).
    def self.unique_token(test_run_id, *parts)
      digest(test_run_id, parts)[0, TOKEN_LENGTH]
    end

    # An id like "user_1a2b3c4d5e6f", deterministic per inputs. An empty prefix
    # defaults to "id".
    def self.unique_id(test_run_id, prefix = "id", *parts)
      prefix = "id" if prefix.nil? || prefix.empty?
      "#{prefix}_#{unique_token(test_run_id, prefix, *parts)}"
    end

    # A URL-safe slug like "acme-1a2b3c4d5e6f", deterministic per inputs. An
    # empty base defaults to "item".
    def self.unique_slug(test_run_id, base = "item", *parts)
      base = "item" if base.nil? || base.empty?
      token = unique_token(test_run_id, base, *parts)
      normalized = base.downcase.gsub(SLUG_NON_ALNUM, "-").gsub(SLUG_TRIM_HYPHENS, "")
      normalized = "item" if normalized.empty?
      "#{normalized}-#{token}"
    end

    # An email like "user+1a2b3c4d5e6f@example.com", deterministic per inputs.
    # Empty local/domain default to "user"/"example.com".
    def self.unique_email(test_run_id, local: "user", domain: "example.com")
      local = "user" if local.nil? || local.empty?
      domain = "example.com" if domain.nil? || domain.empty?
      "#{local}+#{unique_token(test_run_id, local, domain)}@#{domain}"
    end

    def self.digest(test_run_id, parts)
      hash = Digest::SHA256.new
      hash.update(test_run_id)
      parts.each do |part|
        hash.update(" ")
        hash.update(part.to_s)
      end
      hash.hexdigest
    end
    private_class_method :digest
  end
end
