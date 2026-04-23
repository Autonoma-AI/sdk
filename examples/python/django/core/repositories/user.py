# =============================================================================
# User Repository
# =============================================================================
# A typical repository with business logic that raw SQL can't replicate.
# Password hashing, email normalization, and welcome email suppression
# are common examples of why factories are needed.

import hashlib

from core.models import User


class UserRepository:
    def create(self, data: dict) -> dict:
        # Business logic: normalize email, hash a default password
        normalized_email = data["email"].strip().lower()
        hashed_password = hashlib.sha256(b"default-test-password").hexdigest()

        user = User.objects.create(
            email=normalized_email,
            name=data["name"],
            organization_id=data["organization_id"],
            # In a real app, the User model would have a password field.
            # This shows why raw SQL INSERT would break: it doesn't know
            # about password hashing, email normalization, etc.
        )
        return {"id": str(user.id), "email": user.email, "name": user.name}
