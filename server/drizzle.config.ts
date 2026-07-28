import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are generated from `src/db/schema.ts` and committed, then applied at startup by
 * `src/db/client.ts`. Nothing generates them at runtime: a deployed container must not be able to
 * decide for itself what its schema should be.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './data/scanner.sqlite',
  },
  strict: true,
  verbose: true,
});
