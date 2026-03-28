# =============================================================================
# Autonoma SDK Configuration
# =============================================================================
# This file configures the Autonoma handler for Django.
#
# In Django, the integration pattern is:
#   1. Create a DjangoAdapter with your models
#   2. Create a handler with create_django_handler
#   3. Mount it in urls.py

import os

from autonoma.types import HandlerConfig
from autonoma_django import DjangoAdapter, create_django_handler

from core.models import Organization, User, Project, Task


# ---------------------------------------------------------------------------
# 1. Create the Django adapter
# ---------------------------------------------------------------------------
# The Django adapter introspects your Django models automatically.
# Unlike SQLAlchemy, you don't need a session factory — Django manages
# database connections internally.
adapter = DjangoAdapter(
    models=[Organization, User, Project, Task],
    scope_field="organization_id",
)

# ---------------------------------------------------------------------------
# 2. Create the handler
# ---------------------------------------------------------------------------
config = HandlerConfig(
    adapter=adapter,
    shared_secret=os.environ.get("AUTONOMA_SHARED_SECRET", "my-shared-secret"),
    signing_secret=os.environ.get("AUTONOMA_SIGNING_SECRET", "my-signing-secret"),
)

# This returns a Django view function decorated with @csrf_exempt and @require_POST
handler = create_django_handler(config)
