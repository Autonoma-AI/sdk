// =============================================================================
// User Repository (free functions)
// =============================================================================
// This example uses plain exported functions. The Python example shows the
// same thing with a class-based repository — both work equally well.

import type { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'

export async function createUser(
  prisma: PrismaClient,
  data: { email: string; name: string; organizationId: string },
) {
  const normalizedEmail = data.email.trim().toLowerCase()
  const hashedPassword = createHash('sha256')
    .update('default-test-password')
    .digest('hex')

  return prisma.user.create({
    data: {
      email: normalizedEmail,
      name: data.name,
      organizationId: data.organizationId,
    },
  })
}
