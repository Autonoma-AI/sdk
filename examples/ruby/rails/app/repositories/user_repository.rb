# =============================================================================
# User Repository
# =============================================================================
# A typical repository with business logic that raw SQL can't replicate.
# Password hashing, email normalization, and welcome email suppression
# are common examples of why factories are needed.

require "digest"

class UserRepository
  def self.create(data)
    # Business logic: normalize email, hash a default password
    normalized_email = data["email"].strip.downcase
    hashed_password = Digest::SHA256.hexdigest("default-test-password")

    user = User.create!(
      email: normalized_email,
      name: data["name"],
      organization_id: data["organizationId"]
      # In a real app, the User model would have a password field.
      # This shows why raw SQL INSERT would break: it doesn't know
      # about password hashing, email normalization, etc.
    )

    { "id" => user.id, "email" => user.email, "name" => user.name }
  end
end
