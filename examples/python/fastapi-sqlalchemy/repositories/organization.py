# =============================================================================
# Organization Repository (class-based)
# =============================================================================
# This example uses a class-based repository. The TypeScript example shows
# the same thing with free functions — both work equally well.

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
        return {"id": org.id, "name": org.name}

    def delete(self, id: str) -> None:
        org = self.session.get(Organization, id)
        if org:
            self.session.delete(org)
            self.session.commit()
