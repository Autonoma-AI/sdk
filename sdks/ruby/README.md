# Autonoma Ruby SDK

Ruby implementation of the Autonoma Environment Factory SDK. Zero hard runtime dependencies (stdlib only), with ActiveRecord and Rails as optional adapters.

## Packages

| Package | Description |
|---------|-------------|
| `autonoma-ai` | Core protocol (HMAC, refs, templates, graph, handler) |
| `autonoma_active_record` | ActiveRecord ORM adapter (require separately) |
| `autonoma_rails` | Rails server adapter -- controller mixin and Rack middleware |

## Quick Start

### Install

Add to your `Gemfile`:

```ruby
gem "autonoma-ai"
```

### Rails + ActiveRecord

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
    @autonoma_config ||= AutonomaActiveRecord.create_config(
      scope_field: "organizationId",
      shared_secret: ENV["AUTONOMA_SHARED_SECRET"],
      signing_secret: ENV["AUTONOMA_SIGNING_SECRET"],
      auth: ->(user) {
        { "headers" => { "Authorization" => "Bearer #{user['id']}" } }
      }
    )
  end
end
```

Requires `require "autonoma_active_record"` and `require "autonoma_rails/server"` in your app.

## Commands

```bash
bundle install
rake test                                       # run all tests
ruby -Ilib -Itest test/test_handler.rb          # run a single test file
```

## Documentation

For protocol-level documentation, see the root [`protocol/`](../../protocol/) directory.
