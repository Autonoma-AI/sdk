# =============================================================================
# Organization Repository
# =============================================================================
# A typical repository that wraps SQLAlchemy with business logic.
# In a real app, this might generate slugs, set up billing, create default
# settings, or call external services (e.g., Stripe customer creation).

from sqlalchemy.orm import Session

from models import Organization


class OrganizationRepository:
    def __init__(self, session: Session):
        self.session = session

    def create(self, data: dict) -> dict:
        org = Organization(name=data["name"])
        self.session.add(org)
        self.session.commit()
        self.session.refresh(org)
        # In a real app you might also:
        # - Create a Stripe customer
        # - Set up default organization settings
        # - Send a welcome email to the creator
        return {"id": org.id, "name": org.name}

    def delete(self, id: str) -> None:
        # Business logic: clean up external resources before deleting
        # In a real app: cancel Stripe subscription, revoke API keys, etc.
        org = self.session.get(Organization, id)
        if org:
            self.session.delete(org)
            self.session.commit()
