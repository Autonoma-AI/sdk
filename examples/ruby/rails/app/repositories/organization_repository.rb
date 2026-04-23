# =============================================================================
# Organization Repository
# =============================================================================
# A typical repository that wraps ActiveRecord with business logic.
# In a real app, this might generate slugs, set up billing, create default
# settings, or call external services (e.g., Stripe customer creation).

class OrganizationRepository
  def self.create(data)
    organization = Organization.create!(
      name: data["name"]
      # In a real app you might also:
      # - Create a Stripe customer
      # - Set up default organization settings
      # - Send a welcome email to the creator
    )

    { "id" => organization.id, "name" => organization.name }
  end

  def self.delete(id)
    # Business logic: clean up external resources before deleting
    # In a real app: cancel Stripe subscription, revoke API keys, etc.
    Organization.find(id).destroy!
  end
end
