# Autonoma SDK — Django Example

A minimal Django application using the Autonoma SDK with Django ORM.

## What this example does

This example shows how to wire up the Autonoma Environment Factory endpoint in a Django project. Unlike the SQLAlchemy examples, Django uses its own ORM — the Autonoma SDK has a dedicated Django adapter that introspects Django models natively.

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

### 3. Set up the database

```bash
# Create the tables from Django model definitions
python manage.py migrate
```

### 4. Start the server

```bash
python manage.py runserver 3000
```

The server will start on http://localhost:3000.

### 5. Test it

```bash
BODY='{"action":"discover"}'
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "my-shared-secret" | awk '{print $2}')

curl -X POST http://localhost:3000/api/autonoma/ \
  -H "Content-Type: application/json" \
  -H "x-signature: $SIGNATURE" \
  -d "$BODY"
```

### 6. Clean up

```bash
docker stop autonoma-postgres
```

## Project structure

```
├── manage.py
├── requirements.txt
├── autonoma_example/           # Django project settings
│   ├── settings.py
│   ├── urls.py
│   └── wsgi.py
└── core/                       # Django app with models
    ├── models.py
    └── autonoma_config.py      # Autonoma SDK configuration
```

## How it works

The key integration in `core/autonoma_config.py`:

```python
from autonoma_django import django_executor, create_django_handler

config = HandlerConfig(
    executor=django_executor(),
    scope_field="organization_id",
    shared_secret="my-shared-secret",
    signing_secret="my-signing-secret",
    auth=lambda user, context: {
        "headers": {"Authorization": "Bearer test-token"}
    },
)

handler = create_django_handler(config)
```

Then in `autonoma_example/urls.py`:

```python
from core.autonoma_config import handler
urlpatterns = [path("api/autonoma/", handler)]
```
