# Autonoma SDK — Rails + ActiveRecord Example

A minimal Rails API application using the Autonoma SDK with ActiveRecord.

## What this example does

This example shows how to wire up the Autonoma Environment Factory endpoint in a Rails application using ActiveRecord as the ORM. The endpoint allows Autonoma to:

1. **Discover** your database schema (models, fields, relationships)
2. **Create** test data (scoped to a test run)
3. **Tear down** test data when done

## Prerequisites

- Ruby 3.1+
- Docker (for PostgreSQL)

## Quick start

### 1. Start PostgreSQL

```bash
docker run --rm -d \
  --name autonoma-postgres \
  -e POSTGRES_USER=autonoma \
  -e POSTGRES_PASSWORD=autonoma \
  -e POSTGRES_DB=autonoma_example \
  -p 5432:5432 \
  postgres:16-alpine
```

### 2. Install dependencies and set up the database

```bash
bundle install
rails db:create db:migrate
```

### 3. Start the server

```bash
rails server -p 3000
```

The server will start on http://localhost:3000.

### 4. Test it

```bash
BODY='{"action":"discover"}'
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "my-shared-secret" | awk '{print $2}')

curl -X POST http://localhost:3000/api/autonoma \
  -H "Content-Type: application/json" \
  -H "x-signature: $SIGNATURE" \
  -d "$BODY"
```

### 5. Clean up

```bash
docker stop autonoma-postgres
```

## Project structure

```
├── app/
│   └── controllers/
│       ├── application_controller.rb   # Base API controller
│       └── autonoma_controller.rb      # Autonoma endpoint handler
├── config/
│   ├── application.rb                  # Minimal Rails application
│   ├── database.yml                    # PostgreSQL connection
│   ├── environment.rb                  # Rails environment loader
│   └── routes.rb                       # Route: POST /api/autonoma
├── db/
│   └── migrate/
│       └── 20240101000000_create_tables.rb
├── config.ru
├── Gemfile
└── Rakefile
```

## How it works

The key integration is in the controller (`app/controllers/autonoma_controller.rb`):

```ruby
require "autonoma_active_record"
require "autonoma_rails"

class AutonomaController < ApplicationController
  include AutonomaRails::Handler

  def handle
    autonoma_handle(autonoma_config)
  end

  private

  def autonoma_config
    @autonoma_config ||= AutonomaActiveRecord.create_config(
      scope_field: "organization_id",
      shared_secret: ENV.fetch("AUTONOMA_SHARED_SECRET", "my-shared-secret"),
      signing_secret: ENV.fetch("AUTONOMA_SIGNING_SECRET", "my-signing-secret"),
      auth: ->(user, _context) {
        { "headers" => { "Authorization" => "Bearer test-token" } }
      }
    )
  end
end
```

The SDK introspects your database schema automatically — no manual configuration of models needed.
