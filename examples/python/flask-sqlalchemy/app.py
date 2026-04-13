# =============================================================================
# Autonoma SDK — Flask + SQLAlchemy Example
# =============================================================================
# This file sets up a minimal Flask server with the Autonoma Environment
# Factory endpoint.

import os

from flask import Flask

from autonoma.types import HandlerConfig
from autonoma_flask import create_flask_handler
from autonoma_sqlalchemy import sqlalchemy_executor

from database import engine, Base
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
# 3. Set up the Autonoma executor and handler
# ---------------------------------------------------------------------------
# The SQLAlchemy executor wraps the engine into a SQL executor that the
# SDK uses for schema introspection, entity creation, and teardown.
config = HandlerConfig(
    executor=sqlalchemy_executor(engine),
    scope_field="organization_id",
    shared_secret=os.environ.get("AUTONOMA_SHARED_SECRET", "my-shared-secret"),
    signing_secret=os.environ.get("AUTONOMA_SIGNING_SECRET", "my-signing-secret"),
    auth=lambda user, context: {
        "headers": {"Authorization": "Bearer test-token"}
    },
)

# Mount the Autonoma blueprint at /api/autonoma
# The create_flask_handler returns a Flask Blueprint.
bp = create_flask_handler(config)
app.register_blueprint(bp, url_prefix="/api/autonoma")
