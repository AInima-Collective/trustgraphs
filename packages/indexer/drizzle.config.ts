import dotenv from 'dotenv'
import { defineConfig } from 'drizzle-kit'

dotenv.config({
  path: '.env.local',
})

export default defineConfig({
  out: './migrations',
  schema: './offchain.schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
