import { defineConfig } from 'drizzle-kit';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  // Root commands run drizzle-kit with the package as cwd. Load the same local
  // .env used by the API/worker without introducing dotenv or printing secrets.
  const rootEnv = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
  if (!existsSync(rootEnv)) return '';
  const line = readFileSync(rootEnv, 'utf8')
    .split(/\r?\n/u)
    .find((candidate) => /^\s*DATABASE_URL\s*=/u.test(candidate));
  if (!line) return '';

  const raw = line.slice(line.indexOf('=') + 1).trim();
  const quoted = raw.match(/^(['"])(.*)\1$/u);
  return quoted?.[2] ?? raw;
}

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
    url: databaseUrl(),
  },
  strict: true,
  verbose: true,
});
