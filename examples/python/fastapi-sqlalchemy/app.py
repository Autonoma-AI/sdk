# =============================================================================
# Autonoma SDK — FastAPI + SQLAlchemy Example (Factory-driven)
# =============================================================================
# The SDK is factory-driven: every model the dashboard can create has a
# registered factory whose `input_model` (Pydantic) drives both validation
# and the discover schema. There is no SQL introspection, no SQL fallback,
# and no executor — your factories use whatever SQLAlchemy session your app
# already has.

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict

from autonoma.types import HandlerConfig
from autonoma.factory import define_factory
from autonoma_fastapi import create_fastapi_handler

from database import engine, Base, SessionLocal
from repositories.organization import OrganizationRepository
from repositories.user import UserRepository
import models  # noqa: F401 — imported so Base.metadata.create_all() can discover tables


# ---------------------------------------------------------------------------
# 1. Initialize repositories
# ---------------------------------------------------------------------------
# This example wires factories via class-based repositories. The TypeScript
# example shows the same thing with free functions — both work equally well.
session = SessionLocal()
organization_repo = OrganizationRepository(session)
user_repo = UserRepository(session)


# ---------------------------------------------------------------------------
# 2. Create tables on startup
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    print("Database tables created.")
    yield


# ---------------------------------------------------------------------------
# 3. Create the FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="Autonoma Example", lifespan=lifespan)


# ---------------------------------------------------------------------------
# 4. Declare the factory input/ref models
# ---------------------------------------------------------------------------
# Every field the dashboard sends in `create.<Model>[i]` should appear here.
# `extra="ignore"` lets recipes carry display-only metadata (e.g. `_alias`)
# without failing validation.

class OrganizationInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str


class OrganizationRef(BaseModel):
    id: str
    name: str


class UserInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    email: str
    name: str
    organization_id: str


# ---------------------------------------------------------------------------
# 5. Named factory functions
# ---------------------------------------------------------------------------
# Named functions instead of lambdas — easier to test and debug.
# data is a validated Pydantic instance (OrganizationInput / UserInput).

def create_organization_factory(data: OrganizationInput, ctx):
    return organization_repo.create({"name": data.name})


def delete_organization_factory(record, ctx):
    organization_repo.delete(record.id)


def create_user_factory(data: UserInput, ctx):
    return user_repo.create({
        "email": data.email,
        "name": data.name,
        "organization_id": data.organization_id,
    })


# ---------------------------------------------------------------------------
# 6. Build the handler config
# ---------------------------------------------------------------------------
config = HandlerConfig(
    # The column that scopes all models to a tenant (e.g. organization_id).
    scope_field="organization_id",
    # Shared with Autonoma — verifies incoming requests via HMAC-SHA256.
    shared_secret=os.environ.get("AUTONOMA_SHARED_SECRET", "my-shared-secret"),
    # Private to your server only — signs the refs token so teardown only
    # deletes what was created.
    signing_secret=os.environ.get("AUTONOMA_SIGNING_SECRET", "my-signing-secret"),

    # Required: the endpoint returns 404 unless this is True. The SDK never
    # inspects PYTHON_ENV/ENV — tie it to your own condition to keep it off in
    # prod, e.g. allow_production=os.environ.get("PYTHON_ENV") != "production".
    allow_production=True,

    # One factory per model. The factory's `input_model` drives both the
    # discover schema and create-time validation; `data` arrives as a
    # validated Pydantic instance.
    factories={
        "Organization": define_factory(
            create=create_organization_factory,
            teardown=delete_organization_factory,
            input_model=OrganizationInput,
            ref_model=OrganizationRef,
        ),

        "User": define_factory(
            create=create_user_factory,
            input_model=UserInput,
        ),
    },

    # Called after `up` — returns credentials so Autonoma can make
    # authenticated requests as the test user.
    auth=lambda user, context: {
        "headers": {"Authorization": "Bearer test-token"}
    },
)

# Mount the Autonoma router at /api/autonoma.
router = create_fastapi_handler(config)
app.include_router(router, prefix="/api/autonoma")
