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
from autonoma_sqlalchemy import SQLAlchemyAdapter

from database import SessionLocal, engine, Base
from models import Organization, User, Project, Task


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
# 3. Set up the Autonoma adapter and handler
# ---------------------------------------------------------------------------
# The SQLAlchemy adapter needs:
#   - session_factory: a callable that returns new database sessions
#   - models: the list of SQLAlchemy model classes to expose
#   - scope_field: the field name used for data isolation
adapter = SQLAlchemyAdapter(
    session_factory=SessionLocal,
    models=[Organization, User, Project, Task],
    scope_field="organization_id",
)

# Create the handler config
config = HandlerConfig(
    adapter=adapter,
    # Shared secret — both you and Autonoma know this.
    shared_secret=os.environ.get("AUTONOMA_SHARED_SECRET", "my-shared-secret"),
    # Signing secret — only you know this.
    signing_secret=os.environ.get("AUTONOMA_SIGNING_SECRET", "my-signing-secret"),
)

# Mount the Autonoma router at /api/autonoma
# The create_fastapi_handler returns an APIRouter that handles POST requests.
router = create_fastapi_handler(config)
app.include_router(router, prefix="/api/autonoma")
