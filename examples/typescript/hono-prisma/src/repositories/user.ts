// =============================================================================
// User Repository
// =============================================================================
// A typical repository with business logic that raw SQL can't replicate.
// Password hashing, email normalization, and welcome email suppression
// are common examples of why factories are needed.

import type { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'

export class UserRepository {
  constructor(private prisma: PrismaClient) {}

  async create(data: { email: string; name: string; organizationId: string }) {
    // Business logic: normalize email, hash a default password
    const normalizedEmail = data.email.trim().toLowerCase()
    const hashedPassword = createHash('sha256')
      .update('default-test-password')
      .digest('hex')

    return this.prisma.user.create({
      data: {
        email: normalizedEmail,
        name: data.name,
        organizationId: data.organizationId,
        // In a real app, the User model would have a password field.
        // This shows why raw SQL INSERT would break: it doesn't know
        // about password hashing, email normalization, etc.
      },
    })
  }
}
