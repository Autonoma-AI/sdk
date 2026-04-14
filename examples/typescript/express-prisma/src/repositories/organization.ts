// =============================================================================
// Organization Repository
// =============================================================================
// A typical repository that wraps Prisma with business logic.
// In a real app, this might generate slugs, set up billing, create default
// settings, or call external services (e.g., Stripe customer creation).

import type { PrismaClient } from '@prisma/client'

export class OrganizationRepository {
  constructor(private prisma: PrismaClient) {}

  async create(data: { name: string }) {
    return this.prisma.organization.create({
      data: {
        name: data.name,
        // In a real app you might also:
        // - Create a Stripe customer
        // - Set up default organization settings
        // - Send a welcome email to the creator
      },
    })
  }

  async delete(id: string) {
    // Business logic: clean up external resources before deleting
    // In a real app: cancel Stripe subscription, revoke API keys, etc.
    return this.prisma.organization.delete({ where: { id } })
  }
}
