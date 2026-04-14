# =============================================================================
# Autonoma SDK Configuration (Hybrid Factories + SQL)
# =============================================================================
# This example shows how to use factories for models with business logic
# (Organization, User) while letting the SDK handle simpler models (Project,
# Task) via raw SQL. This "hybrid" approach gives you the best of both worlds:
# correct business logic where it matters, zero setup where it doesn't.
#
# In Django, the integration pattern is:
#   1. Create a DjangoExecutor (wraps Django's database connection)
#   2. Create repository instances for models with business logic
#   3. Create a handler with factories and create_django_handler
#   4. Mount it in urls.py

import os

from autonoma.types import HandlerConfig
from autonoma.factory import define_factory
from autonoma_django import django_executor, create_django_handler

from core.repositories.organization import OrganizationRepository
from core.repositories.user import UserRepository


# ---------------------------------------------------------------------------
# 1. Initialize repositories
# ---------------------------------------------------------------------------
# Repositories encapsulate business logic (password hashing, slug generation,
# external service calls, etc.) that raw SQL can't replicate.
organization_repo = OrganizationRepository()
user_repo = UserRepository()


# ---------------------------------------------------------------------------
# 2. Create the handler config with Factories
# ---------------------------------------------------------------------------
# Factories let you use your own repositories/services to create test data.
# The SDK still handles scenario resolution, FK ordering, and teardown —
# but delegates actual creation to your code for models that need it.
#
# Models WITHOUT a factory (Project, Task) fall back to raw SQL INSERT,
# which works fine for simple tables without business logic.
config = HandlerConfig(
    executor=django_executor(),
    scope_field="organization_id",
    shared_secret=os.environ.get("AUTONOMA_SHARED_SECRET", "my-shared-secret"),
    signing_secret=os.environ.get("AUTONOMA_SIGNING_SECRET", "my-signing-secret"),

    # Register factories for models that have business logic
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

    auth=lambda user, context: {
        "headers": {"Authorization": "Bearer test-token"}
    },
)

# ---------------------------------------------------------------------------
# 3. Create the Django view handler
# ---------------------------------------------------------------------------
# This returns a Django view function decorated with @csrf_exempt and @require_POST
handler = create_django_handler(config)
