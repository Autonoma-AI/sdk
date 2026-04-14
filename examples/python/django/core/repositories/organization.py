# =============================================================================
# Organization Repository
# =============================================================================
# A typical repository that wraps Django ORM with business logic.
# In a real app, this might generate slugs, set up billing, create default
# settings, or call external services (e.g., Stripe customer creation).

from core.models import Organization


class OrganizationRepository:
    def create(self, data: dict) -> dict:
        org = Organization.objects.create(name=data["name"])
        # In a real app you might also:
        # - Create a Stripe customer
        # - Set up default organization settings
        # - Send a welcome email to the creator
        return {"id": str(org.id), "name": org.name}

    def delete(self, id: str) -> None:
        # Business logic: clean up external resources before deleting
        # In a real app: cancel Stripe subscription, revoke API keys, etc.
        Organization.objects.filter(id=id).delete()
