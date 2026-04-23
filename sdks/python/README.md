# Autonoma Python SDK

Python implementation of the Autonoma Environment Factory SDK.

## Package

| Package | Description |
|---------|-------------|
| `autonoma-ai` | Core protocol (HMAC, refs, graph, handler) |
| `autonoma-ai[sqlalchemy]` | SQLAlchemy executor adapter |
| `autonoma-ai[django]` | Django executor adapter and server handler |
| `autonoma-ai[flask]` | Flask server adapter |
| `autonoma-ai[fastapi]` | FastAPI server adapter |
| `autonoma-ai[postgres]` | PostgreSQL driver (psycopg2) |
| `autonoma-ai[all]` | All adapters and drivers |

## Quick Start

### Install

```bash
pip install autonoma-ai
# With extras:
pip install "autonoma-ai[sqlalchemy,fastapi,postgres]"
# Or everything:
pip install "autonoma-ai[all]"
```

### FastAPI + SQLAlchemy

```python
from autonoma.types import HandlerConfig
from autonoma_fastapi import create_fastapi_handler
from autonoma_sqlalchemy import sqlalchemy_executor
from sqlalchemy import create_engine

engine = create_engine("postgresql://user:pass@localhost/mydb")

config = HandlerConfig(
    executor=sqlalchemy_executor(engine),
    scope_field="organization_id",
    shared_secret="your-shared-secret",
    signing_secret="your-signing-secret",
    auth=lambda user, context: {
        "headers": {"Authorization": f"Bearer {create_session_token(user['id'])}"}
    },
)

router = create_fastapi_handler(config)
app.include_router(router, prefix="/api/autonoma")
```

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

- Your tables are plural but you want singular factory keys: `organizations` table ↔ `Organization` key.
- Legacy short names: `usr` table ↔ `User` key, `acl` table ↔ `AccessControl` key.

The map is **sparse, not exhaustive**: only list entries that actually differ. Auto-derivation covers the rest.

```python
# Tables in DB: organization, user, api_key, deal   (singular)
# Factories keyed: Organization, User, ApiKey, Deal
# table_name_map = None  # auto-derive is exact; omit the kwarg

# Tables in DB: organizations, users, api_keys
# Factories keyed singular → every entry disagrees:
config = HandlerConfig(
    ...,
    table_name_map={
        "Organization": "organizations",
        "User": "users",
        "ApiKey": "api_keys",
    },
    factories={"Organization": ..., "User": ..., "ApiKey": ...},
)
```

**Red flag:** if your `table_name_map` has one entry per factory and every entry is just a plural↔singular rename, consider keeping factory keys plural (`Organizations`) and dropping the map entirely. Plural keys are valid — pick whichever convention your scenarios use.

## Commands

```bash
poetry install --all-extras   # install with all adapters
poetry run pytest              # run tests
poetry run pytest -k "sqlalchemy"  # tests matching pattern
```

## Documentation

For protocol-level documentation, see the root [`protocol/`](../../protocol/) directory. For runnable examples, see [`examples/python/`](../../examples/python/).
