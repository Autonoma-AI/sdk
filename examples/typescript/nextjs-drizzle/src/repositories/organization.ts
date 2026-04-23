// =============================================================================
// Organization Repository (Drizzle)
// =============================================================================
// A typical repository that wraps Drizzle with business logic.
// In a real app, this might generate slugs, set up billing, create default
// settings, or call external services (e.g., Stripe customer creation).

import { db } from '@/db'
import { organizations } from '@/db/schema'
import { eq } from 'drizzle-orm'

export class OrganizationRepository {
  async create(data: { name: string }) {
    const [organization] = await db
      .insert(organizations)
      .values({
        name: data.name,
        // In a real app you might also:
        // - Create a Stripe customer
        // - Set up default organization settings
        // - Send a welcome email to the creator
      })
      .returning()

    return organization
  }

  async delete(id: string) {
    // Business logic: clean up external resources before deleting
    // In a real app: cancel Stripe subscription, revoke API keys, etc.
    const [deleted] = await db
      .delete(organizations)
      .where(eq(organizations.id, id))
      .returning()

    return deleted
  }
}
