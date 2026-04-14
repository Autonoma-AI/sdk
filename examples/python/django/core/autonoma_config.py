# =============================================================================
# Autonoma SDK Configuration
# =============================================================================
# This file configures the Autonoma handler for Django.
#
# In Django, the integration pattern is:
#   1. Create a DjangoExecutor (wraps Django's database connection)
#   2. Create a handler with create_django_handler
#   3. Mount it in urls.py

import os

from autonoma.types import HandlerConfig
from autonoma_django import django_executor, create_django_handler


# ---------------------------------------------------------------------------
# 1. Create the handler config
# ---------------------------------------------------------------------------
# The Django executor wraps Django's database connection into a SQL executor.
# Unlike SQLAlchemy, you don't need an engine — Django manages database
# connections internally.
config = HandlerConfig(
    executor=django_executor(),
    scope_field="organization_id",
    shared_secret=os.environ.get("AUTONOMA_SHARED_SECRET", "my-shared-secret"),
    signing_secret=os.environ.get("AUTONOMA_SIGNING_SECRET", "my-signing-secret"),
    auth=lambda user, context: {
        "headers": {"Authorization": "Bearer test-token"}
    },
)

# ---------------------------------------------------------------------------
# 2. Create the Django view handler
# ---------------------------------------------------------------------------
# This returns a Django view function decorated with @csrf_exempt and @require_POST
handler = create_django_handler(config)
