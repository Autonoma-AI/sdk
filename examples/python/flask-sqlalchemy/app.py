# =============================================================================
# Autonoma SDK — Flask + SQLAlchemy Example (Hybrid Factories + SQL)
# =============================================================================
# This example shows how to use factories for models with business logic
# (Organization, User) while letting the SDK handle simpler models (Project,
# Task) via raw SQL. This "hybrid" approach gives you the best of both worlds:
# correct business logic where it matters, zero setup where it doesn't.

import os

from flask import Flask

from autonoma.types import HandlerConfig
from autonoma.factory import define_factory
from autonoma_flask import create_flask_handler
from autonoma_sqlalchemy import sqlalchemy_executor

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
# In a real app you'd use Alembic migrations.
with app.app_context():
    Base.metadata.create_all(bind=engine)
    print("Database tables created.")

# ---------------------------------------------------------------------------
# 3. Initialize repositories
# ---------------------------------------------------------------------------
# Repositories encapsulate business logic (password hashing, slug generation,
# external service calls, etc.) that raw SQL can't replicate.
session = SessionLocal()
organization_repo = OrganizationRepository(session)
user_repo = UserRepository(session)

# ---------------------------------------------------------------------------
# 4. Set up the Autonoma executor and handler with Factories
# ---------------------------------------------------------------------------
# Factories let you use your own repositories/services to create test data.
# The SDK still handles scenario resolution, FK ordering, and teardown —
# but delegates actual creation to your code for models that need it.
#
# Models WITHOUT a factory (Project, Task) fall back to raw SQL INSERT,
# which works fine for simple tables without business logic.
config = HandlerConfig(
    # Connects the SDK to your database through your ORM (Prisma, Drizzle, SQLAlchemy, etc.)
    executor=sqlalchemy_executor(engine),
    # The column that scopes all models to a tenant (e.g. organization_id). The SDK uses this to
    # isolate test data and ensure teardown only removes records belonging to the test run.
    scope_field="organization_id",
    # Shared between your server and Autonoma. Used to verify incoming requests via HMAC-SHA256.
    shared_secret=os.environ.get("AUTONOMA_SHARED_SECRET", "my-shared-secret"),
    # Private to your server only. Used to sign the refs token that tracks created records,
    # so teardown can only delete what was created.
    signing_secret=os.environ.get("AUTONOMA_SIGNING_SECRET", "my-signing-secret"),

    # Custom create/teardown logic for models with business logic (password hashing, slug
    # generation, etc.). Models without a factory fall back to raw SQL INSERT.
    factories={
        # Organization: uses the repository which handles slug generation,
        # default settings, external service setup, etc.
        "Organization": define_factory(
            create=lambda data, ctx: organization_repo.create(
                {"name": data["name"]},
            ),
            teardown=lambda record, ctx: organization_repo.delete(record["id"]),
        ),

        # User: uses the repository which handles password hashing,
        # email normalization, and other business logic.
        # No teardown defined — the SDK falls back to SQL DELETE.
        "User": define_factory(
            create=lambda data, ctx: user_repo.create(
                {
                    "email": data["email"],
                    "name": data["name"],
                    "organization_id": data["organization_id"],
                },
            ),
        ),

        # Project and Task have no factories — they use raw SQL INSERT.
        # This is fine because they're simple tables with no business logic.
    },

    # Called after entity creation during `up`. Returns credentials (cookies, headers, tokens)
    # so Autonoma can make authenticated requests as the test user.
    auth=lambda user, context: {
        "headers": {"Authorization": "Bearer test-token"}
    },
)

# Mount the Autonoma blueprint at /api/autonoma
# The create_flask_handler returns a Flask Blueprint.
bp = create_flask_handler(config)
app.register_blueprint(bp, url_prefix="/api/autonoma")
