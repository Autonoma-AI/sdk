# =============================================================================
# User Repository
# =============================================================================
# A typical repository with business logic that raw SQL can't replicate.
# Password hashing, email normalization, and welcome email suppression
# are common examples of why factories are needed.

import hashlib

from sqlalchemy.orm import Session

from models import User


class UserRepository:
    def __init__(self, session: Session):
        self.session = session

    def create(self, data: dict) -> dict:
        # Business logic: normalize email, hash a default password
        normalized_email = data["email"].strip().lower()
        hashed_password = hashlib.sha256(b"default-test-password").hexdigest()

        user = User(
            email=normalized_email,
            name=data["name"],
            organization_id=data["organization_id"],
            # In a real app, the User model would have a password field.
            # This shows why raw SQL INSERT would break: it doesn't know
            # about password hashing, email normalization, etc.
        )
        self.session.add(user)
        self.session.commit()
        self.session.refresh(user)
        return {"id": user.id, "email": user.email, "name": user.name}
