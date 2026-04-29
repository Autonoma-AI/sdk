// =============================================================================
// Organization Repository (free functions)
// =============================================================================
// This example uses plain exported functions. The Python example shows the
// same thing with a class-based repository — both work equally well.

import type { PrismaClient } from '@prisma/client'

export async function createOrganization(
  prisma: PrismaClient,
  data: { name: string },
) {
  return prisma.organization.create({ data: { name: data.name } })
}

export async function deleteOrganization(prisma: PrismaClient, id: string) {
  return prisma.organization.delete({ where: { id } })
}
