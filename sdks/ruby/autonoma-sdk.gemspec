# frozen_string_literal: true

Gem::Specification.new do |spec|
  spec.name          = "autonoma-ai"
  spec.version       = "0.2.5" # x-release-please-version
  spec.authors       = ["Autonoma AI"]
  spec.email         = ["eng@autonoma.ai"]

  spec.summary       = "Autonoma SDK — automate the Autonoma Environment Factory endpoint"
  spec.description   = "Ruby SDK for Scenario v2. Handles HMAC verification, named scenarios, " \
                        "signed teardown tokens, and bounded test-facing data."
  spec.homepage      = "https://autonoma.ai"
  spec.license       = "MIT"

  spec.required_ruby_version = ">= 3.1"

  spec.files         = Dir["lib/**/*.rb"] + Dir["docs/**/*"] + ["AGENTS.md"]
  spec.require_paths = ["lib"]

  spec.metadata = {
    "homepage_uri" => "https://autonoma.ai",
    "source_code_uri" => "https://github.com/Autonoma-AI/sdk"
  }

  # No hard runtime dependencies — core SDK uses only stdlib (openssl, json, base64, securerandom)

  spec.add_development_dependency "minitest", "~> 5.0"
  spec.add_development_dependency "rake", "~> 13.0"
end
