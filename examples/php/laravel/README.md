# Autonoma SDK — Laravel Example

A minimal Laravel application using the Autonoma SDK with PostgreSQL.

## What this example does

This example shows how to wire up the Autonoma Environment Factory endpoint in a Laravel application. The endpoint allows Autonoma to:

1. **Discover** your database schema (tables, columns, relationships)
2. **Create** test data (scoped to a test run)
3. **Tear down** test data when done

## Prerequisites

- PHP 8.2+
- Composer
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
composer install
php artisan migrate
```

### 3. Start the server

```bash
php artisan serve --port=3000
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
├── app/                                    # Application code (empty — SDK handles everything)
├── config/
│   ├── app.php                             # Minimal Laravel application config
│   ├── autonoma.php                        # Autonoma SDK configuration
│   └── database.php                        # PostgreSQL connection
├── database/
│   └── migrations/
│       └── 2024_01_01_000000_create_tables.php
├── composer.json
└── README.md
```

## How it works

The SDK is factory-driven: you register a factory per model with field definitions and `create`/`teardown` functions. The SDK derives the discover schema from your factory definitions — no database introspection needed.

The `config/autonoma.php` file defines the scope field, secrets, factories, and auth callback. The service provider auto-discovers and registers a `POST /api/autonoma` route.
