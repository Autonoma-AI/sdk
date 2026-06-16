# =============================================================================
# Autonoma SDK — Flask + SQLAlchemy Example (Factory-driven)
# =============================================================================
# The SDK is factory-driven: every model the dashboard can create has a
# registered factory whose `input_model` (Pydantic) drives both validation
# and the discover schema. There is no SQL introspection, no SQL fallback,
# and no executor — your factories use whatever SQLAlchemy session your app
# already has.

import os

from flask import Flask
from pydantic import BaseModel, ConfigDict

from autonoma.types import HandlerConfig
from autonoma.factory import define_factory
from autonoma_flask import create_flask_handler

from database import engine, Base, SessionLocal
from repositories.organization import OrganizationRepository
from repositories.user import UserRepository
import models  # noqa: F401 — imported so Base.metadata.create_all() can discover tables


# ---------------------------------------------------------------------------
# 1. Create the Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__)

# ---------------------------------------------------------------------------
# 2. Create tables on startup
# ---------------------------------------------------------------------------
with app.app_context():
    Base.metadata.create_all(bind=engine)
    print("Database tables created.")

# ---------------------------------------------------------------------------
# 3. Initialize repositories
# ---------------------------------------------------------------------------
session = SessionLocal()
organization_repo = OrganizationRepository(session)
user_repo = UserRepository(session)


# ---------------------------------------------------------------------------
# 4. Declare the factory input/ref models
# ---------------------------------------------------------------------------
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
# 5. Build the handler config
# ---------------------------------------------------------------------------
config = HandlerConfig(
    scope_field="organization_id",
    shared_secret=os.environ.get("AUTONOMA_SHARED_SECRET", "my-shared-secret"),
    signing_secret=os.environ.get("AUTONOMA_SIGNING_SECRET", "my-signing-secret"),

    # Required: the endpoint returns 404 unless this is True. The SDK never
    # inspects PYTHON_ENV/ENV — tie it to your own condition to keep it off in
    # prod, e.g. allow_production=os.environ.get("PYTHON_ENV") != "production".
    allow_production=True,

    factories={
        "Organization": define_factory(
            create=lambda data, ctx: organization_repo.create({"name": data.name}),
            teardown=lambda record, ctx: organization_repo.delete(record.id),
            input_model=OrganizationInput,
            ref_model=OrganizationRef,
        ),

        "User": define_factory(
            create=lambda data, ctx: user_repo.create(
                {
                    "email": data.email,
                    "name": data.name,
                    "organization_id": data.organization_id,
                },
            ),
            input_model=UserInput,
        ),
    },

    auth=lambda user, context: {
        "headers": {"Authorization": "Bearer test-token"}
    },
)

# Mount the Autonoma blueprint at /api/autonoma.
bp = create_flask_handler(config)
app.register_blueprint(bp, url_prefix="/api/autonoma")
