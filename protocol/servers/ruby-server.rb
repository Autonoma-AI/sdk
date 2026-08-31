#!/usr/bin/env ruby
# frozen_string_literal: true

# Minimal stdlib HTTP server that runs the Ruby SDK's v2 handler with a couple
# of scenarios. Used by run-suites.mjs to exercise the shared protocol/suites/*
# against a real Ruby endpoint. It mirrors protocol/servers/go-server.go and
# ts-server.ts, calling Autonoma::Handler.handle_request directly.
#
# Uses only a raw TCPServer loop so it needs no Rails and no gems beyond the
# stdlib (webrick was removed from the stdlib in Ruby 3.0; this avoids it).

require "socket"
require "json"
require "autonoma"

REASON_PHRASES = {
  200 => "OK",
  400 => "Bad Request",
  401 => "Unauthorized",
  403 => "Forbidden",
  404 => "Not Found",
  500 => "Internal Server Error"
}.freeze

shared_secret = ENV["AUTONOMA_SHARED_SECRET"] || "protocol-shared"
signing_secret = ENV["AUTONOMA_SIGNING_SECRET"] || "protocol-signing"
port = (ENV["PORT"] || "4595").to_i

config = Autonoma::HandlerConfig.new(
  shared_secret: shared_secret,
  signing_secret: signing_secret,
  sdk: { "orm" => "none", "server" => "socket" },
  scenarios: [
    Autonoma::Scenario.define_scenario(
      name: "standard",
      description: "A standard seeded environment",
      up: ->(ctx) {
        {
          auth: { "headers" => { "Authorization" => "Bearer token-#{ctx.test_run_id}" } },
          teardown: { "userId" => "user-#{ctx.test_run_id}" }
        }
      },
      down: ->(_ctx) {}
    ),
    Autonoma::Scenario.define_scenario(
      name: "empty",
      description: "Nothing seeded",
      up: ->(_ctx) { {} }
    )
  ]
)

def read_request(client)
  request_line = client.gets
  return nil if request_line.nil?

  headers = {}
  while (line = client.gets)
    break if line == "\r\n" || line == "\n"

    key, _, value = line.partition(":")
    headers[key.strip.downcase] = value.strip
  end

  length = (headers["content-length"] || "0").to_i
  body = length.positive? ? (client.read(length) || "") : ""
  [headers, body]
end

def write_response(client, status, body_json)
  reason = REASON_PHRASES[status] || "OK"
  client.write("HTTP/1.1 #{status} #{reason}\r\n")
  client.write("Content-Type: application/json\r\n")
  client.write("Content-Length: #{body_json.bytesize}\r\n")
  client.write("Connection: close\r\n")
  client.write("\r\n")
  client.write(body_json)
end

server = TCPServer.new("127.0.0.1", port)
puts "ruby-server listening on #{port}"

loop do
  client = server.accept
  begin
    parsed = read_request(client)
    next if parsed.nil?

    headers, body = parsed
    req = Autonoma::HandlerRequest.new(body: body, headers: headers)
    result = Autonoma::Handler.handle_request(config, req)
    write_response(client, result.status, JSON.generate(result.body))
  rescue StandardError => e
    warn "ruby-server error: #{e.message}"
    begin
      write_response(client, 500, JSON.generate({ "error" => e.message, "code" => "INTERNAL_ERROR" }))
    rescue StandardError
      nil
    end
  ensure
    client.close
  end
end
