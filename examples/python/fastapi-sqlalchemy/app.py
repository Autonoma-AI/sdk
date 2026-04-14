# =============================================================================
# Autonoma SDK — FastAPI + SQLAlchemy Example
# =============================================================================
# This file sets up a minimal FastAPI server with the Autonoma Environment
# Factory endpoint. The endpoint allows Autonoma to discover your schema,
# create test data, and tear it down — all automatically.

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI

from autonoma.types import HandlerConfig
from autonoma_fastapi import create_fastapi_handler
from autonoma_sqlalchemy import sqlalchemy_executor

from database import engine, Base
import models  # noqa: F401 — imported so Base.metadata.create_all() can discover tables


# ---------------------------------------------------------------------------
# 1. Create tables on startup
# ---------------------------------------------------------------------------
# In a real app you'd use Alembic migrations. For this example, we create
# tables directly from the model definitions.
@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    print("Database tables created.")
    yield


# ---------------------------------------------------------------------------
# 2. Create the FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="Autonoma Example", lifespan=lifespan)


# ---------------------------------------------------------------------------
# 3. Set up the Autonoma executor and handler
# ---------------------------------------------------------------------------
# The SQLAlchemy executor wraps the engine into a SQL executor that the
# SDK uses for schema introspection, entity creation, and teardown.
config = HandlerConfig(
    executor=sqlalchemy_executor(engine),
    scope_field="organization_id",
    # Shared secret — both you and Autonoma know this.
    shared_secret=os.environ.get("AUTONOMA_SHARED_SECRET", "my-shared-secret"),
    # Signing secret — only you know this.
    signing_secret=os.environ.get("AUTONOMA_SIGNING_SECRET", "my-signing-secret"),
    # Auth callback — called after entity creation during `up`.
    auth=lambda user, context: {
        "headers": {"Authorization": "Bearer test-token"}
    },
)

# Mount the Autonoma router at /api/autonoma
# The create_fastapi_handler returns an APIRouter that handles POST requests.
router = create_fastapi_handler(config)
app.include_router(router, prefix="/api/autonoma")
