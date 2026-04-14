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

## Commands

```bash
poetry install --all-extras   # install with all adapters
poetry run pytest              # run tests
poetry run pytest -k "sqlalchemy"  # tests matching pattern
```

## Documentation

For protocol-level documentation, see the root [`protocol/`](../../protocol/) directory. For runnable examples, see [`examples/python/`](../../examples/python/).
