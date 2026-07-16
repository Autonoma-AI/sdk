# Writing factories (Python)

A factory tells the SDK how to create and delete one model using your own code. You register one factory per model the platform can create, and pass them all to the handler as `factories`. This page is the exact contract; read it before writing any.

## The shape

```python
# factories/organization.py
from pydantic import BaseModel, ConfigDict
from autonoma import define_factory
from app.db import db   # your app's real database client

class OrganizationInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    slug: str

def _create(data, ctx):
    org = db.create_organization(name=data.name, slug=data.slug)
    return {"id": str(org.id), "name": org.name, "slug": org.slug}

def _teardown(record, ctx):
    db.delete_organization(record["id"])

Organization = define_factory(
    create=_create,
    input_model=OrganizationInput,
    teardown=_teardown,
)
```

`define_factory(create, input_model, teardown=None, ref_model=None)` validates the shape at startup and returns a `FactoryDefinition`. Import it from the top-level `autonoma` package. `input_model` is a Pydantic v2 class - Pydantic ships as a hard dependency of the SDK, so there is nothing extra to install.

## input_model (required)

A Pydantic v2 `BaseModel` describing the fields this model accepts in the create payload. It does two jobs:

1. The SDK validates each incoming record with `input_model.model_validate(...)` before calling `create`.
2. The SDK derives the discover schema from it - there is no database introspection, so this model is how the platform learns your model exists and what fields it has.

Set `model_config = ConfigDict(extra="ignore")` so recipe-only metadata the platform may attach does not trip validation.

**Include every foreign key in the input model, including the scope field.** By the time `create` runs, the SDK has already resolved every `_ref` to the real ID of the referenced record, so a FK arrives as a plain value:

```python
# factories/user.py
from pydantic import BaseModel, ConfigDict
from autonoma import define_factory
from app.signup import create_user   # reuse your real signup code

class UserInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    email: str
    organizationId: str   # arrives as the real Organization id, not a _ref

def _create(data, ctx):
    user = create_user(name=data.name, email=data.email, org_id=data.organizationId)
    return {"id": str(user.id), "email": user.email}

User = define_factory(create=_create, input_model=UserInput)
```

## create(data, ctx)

Creates exactly one record and returns it. It may be a plain `def` or an `async def` - the SDK awaits the result when it is a coroutine.

- `data` - a validated **instance** of `input_model`, so read fields as attributes (`data.name`, `data.organizationId`). FK fields are already real IDs.
- `ctx` - a `FactoryContext` with `refs`, `scenario_name`, and `test_run_id`. `refs` holds every record created so far this run, keyed by model, if you need to look something up.
- **Return value** - a `dict` that includes at least the primary key `id`, or a Pydantic instance (the SDK calls `model_dump()` on it). If the returned record has no `id`, the SDK fails the request with `FACTORY_MISSING_PK`. Everything you return is stored in `refs`, passed to the auth callback, and later handed to `teardown` - so return whatever teardown or auth will need (typically the id, plus fields like `email`).

Reuse your application's real creation path (`create_user`, `create_organization`, a service method). That is the entire point: the test user gets the same password hash, defaults, and side effects a real user would.

## teardown(record, ctx) - optional

Deletes one record. The SDK calls it once per created record, in reverse dependency order, during `down`. It may be sync or async.

- `record` - exactly what your `create` returned: a `dict` (so `record["id"]`), unless you set `ref_model`, in which case it is a validated instance (so `record.id`).
- If you omit `teardown`, the model is never deleted on `down` - the SDK has no SQL fallback. Provide it for every model you create, or those rows leak.

```python
# factories/user.py
def _teardown(record, ctx):
    db.delete_user(record["id"])

User = define_factory(create=_create, input_model=UserInput, teardown=_teardown)
```

## ref_model - optional

A Pydantic v2 class for the record `create` returns. When set, the SDK validates the stored record through `ref_model.model_validate(record)` before `teardown`, and `record` arrives as an instance (attribute access, no dict lookups):

```python
# factories/user.py
class UserRef(BaseModel):
    id: str
    email: str

def _teardown(record, ctx):
    db.delete_user(record.id)   # record is a UserRef instance

User = define_factory(
    create=_create,
    input_model=UserInput,
    teardown=_teardown,
    ref_model=UserRef,
)
```

## Registering factories

Collect every factory into one `dict` keyed by model name - the key must match the model name the platform sends in `create`:

```python
# factories/__init__.py
from factories.organization import Organization
from factories.user import User
from factories.member import Member

factories = {
    "Organization": Organization,
    "User": User,
    "Member": Member,
}
```

Pass that dict as `factories` when you create the handler (see `implement.md`). Every model that appears in a scenario must have an entry here, or the request fails with `INVALID_BODY` ("no factory registered for model ...").
