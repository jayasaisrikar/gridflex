import { defineConfig } from 'drizzle-kit';

/**
 * NOTE (spec 4.1 / 6.1): `drizzle-kit push` is forbidden against any deployed
 * database. Use `drizzle-kit generate` to author a reviewed SQL migration and
 * `drizzle-kit migrate` to apply it, after a verified backup.
 *
 * The initial migration (0000_initial_gridflex.sql) is the supplied authoritative
 * schema copied verbatim. It — not the TypeScript definitions — is the source of
 * truth for extensions, enums, functions, and triggers.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
