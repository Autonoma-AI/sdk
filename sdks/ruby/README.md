# Autonoma Ruby SDK

Ruby implementation of the Autonoma Environment Factory SDK. Zero hard runtime dependencies (stdlib only), with Rails as an optional server adapter.

## Packages

| Package | Description |
|---------|-------------|
| `autonoma-ai` | Core protocol (HMAC, refs, graph, handler) |
| `autonoma_rails` | Rails server adapter -- controller mixin and Rack middleware |

## Quick Start

### Install

Add to your `Gemfile`:

```ruby
gem "autonoma-ai"
```

### Rails

```ruby
# config/routes.rb
post "/api/autonoma", to: "autonoma#handle"

# app/controllers/autonoma_controller.rb
class AutonomaController < ApplicationController
  include AutonomaRails::Handler
  skip_before_action :verify_authenticity_token

  def handle
    autonoma_handle(autonoma_config)
  end

  private

  def autonoma_config
    @autonoma_config ||= Autonoma::HandlerConfig.new(
      scope_field: "organizationId",
      shared_secret: ENV["AUTONOMA_SHARED_SECRET"],
      signing_secret: ENV["AUTONOMA_SIGNING_SECRET"],
      factories: {
        "Organization" => Autonoma::Factory.define_factory(
          create: ->(data, ctx) {
            org = Organization.create!(name: data["name"])
            { "id" => org.id.to_s, "name" => org.name }
          },
          input_fields: [{ name: "name", type: "string", required: true }],
          teardown: ->(record, ctx) { Organization.find(record["id"]).destroy! }
        ),
      },
      auth: ->(user, context) {
        { "headers" => { "Authorization" => "Bearer #{user['id']}" } }
      }
    )
  end
end
```

## Commands

```bash
bundle install
rake test                                       # run all tests
ruby -Ilib -Itest test/test_handler.rb          # run a single test file
```

## Documentation

Full agent-facing docs ship inside the gem under [`docs/`](./docs/) (start with [`docs/implement.md`](./docs/implement.md)); [`AGENTS.md`](./AGENTS.md) is the agent pointer. For the language-agnostic wire protocol, see the root [`protocol/`](../../protocol/) directory.
