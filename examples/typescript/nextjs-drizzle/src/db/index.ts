// =============================================================================
// Drizzle Client
// =============================================================================
// Creates a Drizzle ORM instance connected to PostgreSQL.

import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema'

// Create a PostgreSQL connection pool
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://autonoma:autonoma@localhost:5432/autonoma_example',
})

// Create the Drizzle instance with our schema
// The schema is passed here so Drizzle can use it for type-safe queries
// and so the Autonoma SDK can introspect it
export const db = drizzle(pool, { schema })
