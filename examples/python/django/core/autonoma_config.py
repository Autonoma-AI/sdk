# =============================================================================
# Autonoma SDK Configuration (Factory-driven)
# =============================================================================
# The SDK is factory-driven: every model the dashboard can create has a
# registered factory whose `input_model` (Pydantic) drives both validation
# and the discover schema. There is no SQL introspection, no SQL fallback,
# and no executor — your factories use whatever Django ORM access your app
# already has.

import os

from pydantic import BaseModel, ConfigDict

from autonoma.types import HandlerConfig
from autonoma.factory import define_factory
from autonoma_django import create_django_handler

from core.repositories.organization import OrganizationRepository
from core.repositories.user import UserRepository


# ---------------------------------------------------------------------------
# 1. Initialize repositories
# ---------------------------------------------------------------------------
organization_repo = OrganizationRepository()
user_repo = UserRepository()


# ---------------------------------------------------------------------------
# 2. Declare the factory input/ref models
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
# 3. Build the handler config
# ---------------------------------------------------------------------------
config = HandlerConfig(
    scope_field="organization_id",
    shared_secret=os.environ.get("AUTONOMA_SHARED_SECRET", "my-shared-secret"),
    signing_secret=os.environ.get("AUTONOMA_SIGNING_SECRET", "my-signing-secret"),

    # Required: the endpoint returns 404 unless this is True. The SDK never
    # inspects PYTHON_ENV/ENV — tie it to your own condition to keep it off in
    # prod, e.g. allow_production=settings.DEBUG.
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


# ---------------------------------------------------------------------------
# 4. Create the Django view handler
# ---------------------------------------------------------------------------
# Returns a Django view function decorated with @csrf_exempt and @require_POST.
handler = create_django_handler(config)
