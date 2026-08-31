#!/usr/bin/env ruby
# frozen_string_literal: true

# Conformance test bridge for the Ruby SDK.
#
# Reads a JSON test case from stdin, dispatches to the appropriate SDK function,
# and writes the result to stdout. Scenario-v2 dropped the create-graph
# interpreter and fingerprint(), so the Ruby SDK conforms only on the unchanged
# hmac and refs primitives.

$LOAD_PATH.unshift(File.join(__dir__, "..", "lib"))

require "json"
require "autonoma"

data = JSON.parse($stdin.read)

begin
  mod = data["module"]
  fn = data["function"]
  inp = data["input"]

  result = case [mod, fn]
           when ["hmac", "signBody"]
             Autonoma::Hmac.sign_body(inp["body"], inp["secret"])
           when ["hmac", "verifySignature"]
             Autonoma::Hmac.verify_signature(inp["body"], inp["signature"], inp["secret"])
           when ["refs", "signRefs"]
             Autonoma::Refs.sign_refs(inp["payload"], inp["secret"])
           when ["refs", "verifyRefs"]
             payload = Autonoma::Refs.verify_refs(inp["token"], inp["secret"])
             {
               "refs" => payload["refs"],
               "testRunId" => payload["testRunId"],
               "environment" => payload["environment"]
             }
           else
             raise "Unknown module/function: #{mod}.#{fn}"
           end

  puts JSON.generate({ ok: true, result: result })
rescue StandardError => e
  puts JSON.generate({ ok: false, error: e.message })
end
