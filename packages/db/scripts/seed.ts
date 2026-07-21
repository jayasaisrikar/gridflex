/**
 * Canonical demo seed (`pnpm db:seed`).
 *
 * Applies infra/sql/gridflex_seed.sql — the canonical facility from spec §11,
 * matching the simulator constants the engine tests assert against.
 *
 * Idempotent: every statement uses ON CONFLICT DO NOTHING, so re-running is safe.
 * No user is created here — the first account must go through the API's
 * bootstrap-owner endpoint so the password is Argon2id-hashed (spec §8.2).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const text = readFileSync(resolve(here, '../../../.env'), 'utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('DATABASE_URL=')) return line.slice('DATABASE_URL='.length).trim();
  }
  throw new Error('DATABASE_URL is required');
}

async function main(): Promise<void> {
  const seedSql = readFileSync(resolve(here, '../../../infra/sql/gridflex_seed.sql'), 'utf8');
  const client = new pg.Client({
    connectionString: databaseUrl(),
    connectionTimeoutMillis: 8_000,
  });
  await client.connect();

  try {
    // The seed file manages its own BEGIN/COMMIT.
    await client.query(seedSql);

    const facility = await client.query<{
      name: string;
      slug: string;
      normal_load_kw: string;
      minimum_safe_load_kw: string;
      maximum_curtailment_kw: string;
    }>(
      `select name, slug, normal_load_kw, minimum_safe_load_kw, maximum_curtailment_kw
       from facilities where slug = 'lone-star-compute'`,
    );

    if (facility.rowCount === 0) {
      throw new Error('Seed completed but the canonical facility is missing');
    }

    const mechanisms = await client.query<{ code: string; declared_reducible_kw: string }>(
      `select m.code, m.declared_reducible_kw
       from flexibility_mechanisms m
       join facilities f on f.id = m.facility_id
       where f.slug = 'lone-star-compute'
       order by m.code`,
    );

    const constraints = await client.query<{ version: number }>(
      `select c.version from facility_constraints c
       join facilities f on f.id = c.facility_id
       where f.slug = 'lone-star-compute' order by c.version desc limit 1`,
    );

    const row = facility.rows[0]!;
    console.log('Seed OK');
    console.log(`  facility    : ${row.name} (${row.slug})`);
    console.log(`  normal load : ${row.normal_load_kw} kW`);
    console.log(`  safe floor  : ${row.minimum_safe_load_kw} kW`);
    console.log(`  max curtail : ${row.maximum_curtailment_kw} kW`);
    console.log(`  mechanisms  : ${mechanisms.rows.length}`);
    for (const mechanism of mechanisms.rows) {
      console.log(`    - ${mechanism.code}: ${mechanism.declared_reducible_kw} kW declared`);
    }
    console.log(`  constraints : version ${constraints.rows[0]?.version ?? 'none'}`);
    console.log('\nNo user was created. Run bootstrap-owner through the API so the');
    console.log('password is Argon2id-hashed (spec 8.2).');
  } finally {
    await client.end();
  }
}

await main();
