# =============================================================================
# Autonoma SDK — Flask + SQLAlchemy Example
# =============================================================================
# This file sets up a minimal Flask server with the Autonoma Environment
# Factory endpoint.

import os

from flask import Flask

from autonoma.types import HandlerConfig
from autonoma_flask import create_flask_handler
from autonoma_sqlalchemy import SQLAlchemyAdapter

from database import SessionLocal, engine, Base
from models import Organization, User, Project, Task


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
# 3. Set up the Autonoma adapter and handler
# ---------------------------------------------------------------------------
# The SQLAlchemy adapter is shared between FastAPI and Flask — the only
# difference is the server adapter (create_flask_handler vs create_fastapi_handler).
adapter = SQLAlchemyAdapter(
    session_factory=SessionLocal,
    models=[Organization, User, Project, Task],
    scope_field="organization_id",
)

config = HandlerConfig(
    adapter=adapter,
    shared_secret=os.environ.get("AUTONOMA_SHARED_SECRET", "my-shared-secret"),
    signing_secret=os.environ.get("AUTONOMA_SIGNING_SECRET", "my-signing-secret"),
)

# Mount the Autonoma blueprint at /api/autonoma
# The create_flask_handler returns a Flask Blueprint.
bp = create_flask_handler(config)
app.register_blueprint(bp, url_prefix="/api/autonoma")
