# Autonoma Python SDK

Python implementation of the Autonoma Environment Factory SDK.

## Package

| Package | Description |
|---------|-------------|
| `autonoma-ai` | Core protocol (HMAC, refs, graph, handler, schema) |
| `autonoma-ai[django]` | Django server handler |
| `autonoma-ai[flask]` | Flask server adapter |
| `autonoma-ai[fastapi]` | FastAPI server adapter |
| `autonoma-ai[all]` | All server adapters |

## Quick Start

### Install

```bash
pip install autonoma-ai
# With extras:
pip install "autonoma-ai[fastapi]"
# Or everything:
pip install "autonoma-ai[all]"
```

### FastAPI

```python
from pydantic import BaseModel, ConfigDict
from autonoma.types import HandlerConfig
from autonoma.factory import define_factory
from autonoma_fastapi import create_fastapi_handler

class OrganizationInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    slug: str

def create_org(data, ctx):
    org = db.create_organization(name=data.name, slug=data.slug)
    return {"id": str(org.id), "name": org.name, "slug": org.slug}

def teardown_org(record, ctx):
    db.delete_organization(record["id"])

config = HandlerConfig(
    scope_field="organization_id",
    shared_secret="your-shared-secret",
    signing_secret="your-signing-secret",
    factories={
        "Organization": define_factory(
            create=create_org,
            input_model=OrganizationInput,
            teardown=teardown_org,
        ),
    },
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
```

## Documentation

For protocol-level documentation, see the root [`protocol/`](../../protocol/) directory. For runnable examples, see [`examples/python/`](../../examples/python/).
