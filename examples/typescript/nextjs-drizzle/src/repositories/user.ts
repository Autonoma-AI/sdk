// =============================================================================
// User Repository (Drizzle)
// =============================================================================
// A typical repository with business logic that raw SQL can't replicate.
// Password hashing, email normalization, and welcome email suppression
// are common examples of why factories are needed.

import { db } from '@/db'
import { users } from '@/db/schema'
import { createHash } from 'node:crypto'

export class UserRepository {
  async create(data: { email: string; name: string; organizationId: string }) {
    // Business logic: normalize email, hash a default password
    const normalizedEmail = data.email.trim().toLowerCase()
    const hashedPassword = createHash('sha256')
      .update('default-test-password')
      .digest('hex')

    const [user] = await db
      .insert(users)
      .values({
        email: normalizedEmail,
        name: data.name,
        organizationId: data.organizationId,
        // In a real app, the User model would have a password field.
        // This shows why raw SQL INSERT would break: it doesn't know
        // about password hashing, email normalization, etc.
      })
      .returning()

    return user
  }
}
