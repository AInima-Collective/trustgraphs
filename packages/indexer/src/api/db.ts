import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import * as offchainSchema from '../../offchain.schema'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set')
}

export const offchainPool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

export const offchainDb = drizzle(offchainPool, {
  schema: offchainSchema,
})
