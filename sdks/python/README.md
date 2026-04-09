# Autonoma Python SDK

Python implementation of the Autonoma Environment Factory SDK.

## Package

| Package | Description |
|---------|-------------|
| `autonoma-sdk` | Core protocol (HMAC, refs, templates, graph, handler) |
| `autonoma-sdk[sqlalchemy]` | SQLAlchemy ORM adapter |
| `autonoma-sdk[flask]` | Flask server adapter |
| `autonoma-sdk[fastapi]` | FastAPI server adapter |

## Quick Start

### Install

```bash
pip install autonoma-sdk
# With extras:
pip install "autonoma-sdk[sqlalchemy,fastapi]"
```

### FastAPI + SQLAlchemy

```python
from autonoma.handler import handle_request, PROTOCOL_VERSION
from autonoma.types import HandlerConfig, HandlerRequest

config = HandlerConfig(
    shared_secret="your-shared-secret",
    signing_secret="your-signing-secret",
    adapter=my_adapter,
    auth=lambda user: {
        "headers": {"Authorization": f"Bearer {create_session_token(user['id'])}"}
    },
)

@app.post("/api/autonoma")
async def autonoma_endpoint(request: Request):
    body = await request.body()
    headers = dict(request.headers)
    req = HandlerRequest(body=body.decode(), headers=headers)
    result = handle_request(config, req)
    return JSONResponse(content=result.body, status_code=result.status)
```

## Status

The Python SDK core modules (graph, hmac, refs, fingerprint, template) are complete and pass the conformance test suite. ORM and server adapters are planned.

## Commands

```bash
pip install -e ".[dev]"   # install in development mode
pytest                     # run tests
```

## Documentation

For protocol-level documentation, see the root [`protocol/`](../../protocol/) directory.
