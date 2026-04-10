#!/usr/bin/env ruby
# frozen_string_literal: true

$LOAD_PATH.unshift(File.join(__dir__, "..", "lib"))

require "json"
require "autonoma"

data = JSON.parse($stdin.read)

begin
  mod = data["module"]
  fn = data["function"]
  inp = data["input"]

  result = case [mod, fn]
           when ["graph", "topoSort"]
             Autonoma::Graph.topo_sort(inp["nodes"], inp["edges"])
           when ["graph", "findDeferrableEdge"]
             Autonoma::Graph.find_deferrable_edge(inp["cycle"], inp["edges"])
           when ["hmac", "signBody"]
             Autonoma::Hmac.sign_body(inp["body"], inp["secret"])
           when ["hmac", "verifySignature"]
             Autonoma::Hmac.verify_signature(inp["body"], inp["signature"], inp["secret"])
           when ["refs", "signRefs"]
             Autonoma::Refs.sign_refs(inp["payload"], inp["secret"])
           when ["refs", "verifyRefs"]
             Autonoma::Refs.verify_refs(inp["token"], inp["secret"])
           when ["fingerprint", "fingerprint"]
             Autonoma::Fingerprint.fingerprint(inp["value"])
           else
             raise "Unknown module/function: #{mod}.#{fn}"
           end

  puts JSON.generate({ ok: true, result: result })
rescue StandardError => e
  puts JSON.generate({ ok: false, error: e.message })
end
