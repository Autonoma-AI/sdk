# Autonoma SDK — Flask + SQLAlchemy Example

A minimal Flask application using the Autonoma SDK with SQLAlchemy ORM.

## What this example does

This example shows how to wire up the Autonoma Environment Factory endpoint in a Flask app using SQLAlchemy. The endpoint allows Autonoma to discover your schema, create test data, and tear it down.

## Prerequisites

- Python 3.10+
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

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

### 3. Start the server

The app automatically creates the database tables on startup.

```bash
flask run --port 3000
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
├── app.py               # Flask server + Autonoma endpoint
├── models.py            # SQLAlchemy models
├── database.py          # Database connection setup
└── requirements.txt
```

## How it works

The key integration in `app.py`:

```python
from autonoma_flask import create_flask_handler
from autonoma_sqlalchemy import SQLAlchemyAdapter

adapter = SQLAlchemyAdapter(SessionLocal, [Organization, User, Project, Task], scope_field="organization_id")

bp = create_flask_handler(HandlerConfig(
    adapter=adapter,
    shared_secret="my-shared-secret",
    signing_secret="my-signing-secret",
))

app.register_blueprint(bp, url_prefix="/api/autonoma")
```
