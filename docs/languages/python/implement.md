# Implement the endpoint (Python)

Follow these steps to stand up a working Environment Factory endpoint. This is written for a coding agent doing the integration; do the steps in order and do not skip the validation step.

## Prerequisites

- A Python 3.10+ backend on FastAPI, Flask, or Django.
- The database client your app already uses (SQLAlchemy, Django ORM, raw `psycopg` - it does not matter; your factories call it).
- Pydantic v2. It ships as a hard dependency of the SDK, so it installs automatically.

## Step 1 - Detect the stack and pick packages

Install the core distribution `autonoma-ai` with the extra that matches the app's HTTP framework. There is no ORM adapter package to install - the SDK is factory-driven.

| Framework | Install command | Handler module | Handler function |
|-----------|-----------------|----------------|------------------|
| FastAPI | `pip install "autonoma-ai[fastapi]"` | `autonoma_fastapi` | `create_fastapi_handler` |
| Flask | `pip install "autonoma-ai[flask]"` | `autonoma_flask` | `create_flask_handler` |
| Django | `pip install "autonoma-ai[django]"` | `autonoma_django` | `create_django_handler` |

```bash
# terminal - example: FastAPI
pip install "autonoma-ai[fastapi]"
```

The import package is `autonoma` (plus the framework module), even though the distribution is named `autonoma-ai`. Use the project's package manager (pip, poetry, uv) as appropriate; `pip install "autonoma-ai[all]"` pulls every adapter.

## Step 2 - Generate the two secrets

```bash
# terminal
openssl rand -hex 32   # AUTONOMA_SHARED_SECRET
openssl rand -hex 32   # AUTONOMA_SIGNING_SECRET  (must be different)
```

Add both to your environment (and placeholders to `.env.example` if it exists). The SDK raises `SAME_SECRETS` if they match.

```bash
# .env
AUTONOMA_SHARED_SECRET=...   # shared with Autonoma
AUTONOMA_SIGNING_SECRET=...  # private, never shared
```

## Step 3 - Find the scope field

Read the database schema. Find the foreign key that appears on the most models and points at a single root entity - commonly `organizationId`, `orgId`, `tenantId`, or `workspaceId`. That is the scope field. The root model itself (e.g. `Organization`) does not carry it.

Confirm the field, the endpoint path, and the app's auth mechanism with the user before writing code.

## Step 4 - Write a factory per model

Write one factory for each model the platform will create, calling your app's real creation code. See `factories.md` for the full contract. Collect them into one registry keyed by model name:

```python
# factories/__init__.py
from factories.organization import Organization
from factories.user import User
from factories.member import Member

factories = {"Organization": Organization, "User": User, "Member": Member}
```

## Step 5 - Wire the handler

Create one `HandlerConfig` and pass it to your adapter's handler function. The config carries the scope field, both secrets, the factory registry, the gate flag, and the auth callback. All config fields are `snake_case`.

```python
# app/autonoma_endpoint.py  (FastAPI)
import os
from autonoma import HandlerConfig
from autonoma_fastapi import create_fastapi_handler
from factories import factories
from app.auth import create_session   # your app's real session code

config = HandlerConfig(
    scope_field="organizationId",
    shared_secret=os.environ["AUTONOMA_SHARED_SECRET"],
    signing_secret=os.environ["AUTONOMA_SIGNING_SECRET"],
    factories=factories,
    allow_production=True,   # see Step 7
    auth=lambda user, ctx: {
        "cookies": [
            {"name": "session", "value": create_session(user["id"]),
             "httpOnly": True, "sameSite": "lax", "path": "/"}
        ],
    },
)

router = create_fastapi_handler(config)
app.include_router(router, prefix="/api/autonoma")
```

Other frameworks use the same `config` object; only the mounting differs:

```python
# app/autonoma_endpoint.py  (Flask)
from autonoma_flask import create_flask_handler

bp = create_flask_handler(config)
app.register_blueprint(bp, url_prefix="/api/autonoma")
```

```python
# urls.py  (Django)
from django.urls import path
from autonoma_django import create_django_handler
from app.autonoma_endpoint import config

urlpatterns = [
    path("api/autonoma", create_django_handler(config)),
]
```

The Flask and FastAPI adapters register their route at `/`, so with a `/api/autonoma` prefix the live path is `/api/autonoma/` (trailing slash). With Django you control the exact path in `urls.py`.

FastAPI also accepts `create_fastapi_handler(config_factory=make_config)` - a zero-arg callable that returns a fresh `HandlerConfig` per request, useful when a factory needs per-request state such as a database session.

## Step 6 - Implement the auth callback

This is the part that most often breaks tests, so get it right. The callback receives the first created `User` record as a `dict` (or `None` if the scenario made none) and an `AuthContext` with `scope_value` and `refs`. It must return **real, working credentials** using the app's actual auth mechanism. If it returns a fake or hardcoded token, every test fails at login. The callback may be sync or async (`async def`).

The return type is a dict with any of `cookies`, `headers`, `credentials` - there is no top-level `token` field. Pick the shape that matches how your app authenticates:

```python
# app/autonoma_endpoint.py
# Session cookie (most web apps)
def auth(user, ctx):
    token = create_session(user["id"])
    return {"cookies": [
        {"name": "session", "value": token, "httpOnly": True, "sameSite": "lax", "path": "/"}
    ]}

# JWT bearer token (APIs, SPAs) - the token goes in a header
def auth(user, ctx):
    token = jwt.encode({"sub": user["id"]}, os.environ["JWT_SECRET"], algorithm="HS256")
    return {"headers": {"Authorization": f"Bearer {token}"}}

# Email + password (the runner logs in through the UI, e.g. mobile)
def auth(user, ctx):
    return {"credentials": {"email": user["email"], "password": "test-password-123"}}
```

For the email/password shape, the `User` factory must create the record with a matching password hash, so a real login succeeds.

## Step 7 - Enable the endpoint

The endpoint returns `404 PRODUCTION_BLOCKED` until `allow_production` is `True`. The SDK never inspects `PYTHON_ENV`, `DJANGO_SETTINGS_MODULE`, or any environment variable - this flag is the only switch, so you own the condition:

```python
# app/autonoma_endpoint.py
allow_production=True,                                    # always on
allow_production=os.environ.get("APP_ENV") != "production",   # off in prod
```

## Step 8 - Validate before deploying

Dry-run your scenarios against a real database with `check_scenario` and iterate until they pass. See `validation.md`. Never ship a scenario you have not validated.

## Step 9 - Smoke-test with curl

```bash
# terminal
SECRET="your-shared-secret"
BODY='{"action":"discover"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/.*= //')
curl -s -X POST http://localhost:8000/api/autonoma/ \
  -H "Content-Type: application/json" -H "x-signature: $SIG" -d "$BODY" | jq .
```

Expected: a JSON schema listing your models and `scopeField`. A `404` means `allow_production` is not set or the route is not mounted; a `401` means the secret does not match.

## Step 10 - Report and connect

Tell the user the endpoint path, confirm all scenarios pass, and hand off:

1. Set `AUTONOMA_SHARED_SECRET` and `AUTONOMA_SIGNING_SECRET` in staging/production env.
2. Deploy the endpoint.
3. Paste `AUTONOMA_SHARED_SECRET` into the Autonoma dashboard when connecting the app.

## Rules

**Do:**
- Reuse the app's existing DB client and real creation code inside factories.
- Return real credentials from `auth` using the app's own session/JWT logic.
- Register a factory (with a `teardown`) for every model any scenario creates.
- Match the project's conventions: import style, file layout, naming.
- Validate every scenario with `check_scenario` before deploying.

**Do not:**
- Implement HMAC, token signing, or teardown ordering yourself - the SDK owns all of it.
- Return a hardcoded token like `"test-token"` from `auth`.
- Use the same value for `shared_secret` and `signing_secret`.
- Set `id`, defaulted fields, or auto timestamps in scenario data.
- Expect the SDK to inject the scope field or wire any FK - you set every FK as a `_ref`.
