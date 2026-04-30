# Autonoma Ruby SDK

Ruby implementation of the Autonoma Environment Factory SDK. Zero hard runtime dependencies (stdlib only), with ActiveRecord and Rails as optional adapters.

## Packages

| Package | Description |
|---------|-------------|
| `autonoma-ai` | Core protocol (HMAC, refs, graph, handler) |
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
      auth: ->(user, context) {
        { "headers" => { "Authorization" => "Bearer #{user['id']}" } }
      }
    )
  end
end
```

Requires `require "autonoma_active_record"` and `require "autonoma_rails/server"` in your app.

## Model name ↔ table name

By default, the SDK derives a model name from each SQL table by splitting on `_` and PascalCasing each part — **no pluralization**. Examples:

| SQL table | Auto-derived model name |
|-----------|-------------------------|
| `user` | `User` |
| `api_key` | `ApiKey` |
| `branch_deployment` | `BranchDeployment` |
| `organizations` | `Organizations` (stays plural) |
| `api_keys` | `ApiKeys` (stays plural) |

If every factory you register is keyed under the auto-derived name, **omit `table_name_map` entirely**. The SDK handles the mapping.

You only need `table_name_map` when a factory key disagrees with the auto-derived name. Common reasons:

- Your tables are plural but you want singular factory keys: `organizations` table ↔ `"Organization"` key.
- Legacy short names: `usr` table ↔ `"User"` key, `acl` table ↔ `"AccessControl"` key.

The map is **sparse, not exhaustive**: only list entries that actually differ. Auto-derivation covers the rest.

```ruby
# Tables in DB: organization, user, api_key, deal   (singular)
# Factories keyed: "Organization", "User", "ApiKey", "Deal"
# table_name_map: nil  # omit; auto-derive is exact

# Tables in DB: organizations, users, api_keys
# Factories keyed singular → every entry disagrees:
Autonoma::HandlerConfig.new(
  # ...
  table_name_map: {
    "Organization" => "organizations",
    "User"         => "users",
    "ApiKey"       => "api_keys"
  },
  factories: { "Organization" => ..., "User" => ..., "ApiKey" => ... }
)
```

**Red flag:** if your `table_name_map` has one entry per factory and every entry is just a plural↔singular rename, consider keeping factory keys plural (`"Organizations"`) and dropping the map entirely. Plural keys are valid — pick whichever convention your scenarios use.

## Commands

```bash
bundle install
rake test                                       # run all tests
ruby -Ilib -Itest test/test_handler.rb          # run a single test file
```

## Documentation

For protocol-level documentation, see the root [`protocol/`](../../protocol/) directory.
