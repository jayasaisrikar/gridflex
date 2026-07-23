import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { LOCAL_PILOT, STALE_TELEMETRY_PILOT } from './pilot-data';

const ROOT = resolve(__dirname, '../../..');
const DEFAULT_DATABASE_URL =
  'postgresql://gridflex:gridflex@127.0.0.1:5433/gridflex';
const execFileAsync = promisify(execFile);

/**
 * Prepares deterministic operators and facilities in the disposable local
 * browser-test database. External databases are never mutated by this setup.
 */
export default async function globalSetup() {
  const suppliedEmail = process.env.GRIDFLEX_E2E_EMAIL;
  const suppliedPassword = process.env.GRIDFLEX_E2E_PASSWORD;
  if (Boolean(suppliedEmail) !== Boolean(suppliedPassword)) {
    throw new Error(
      'GRIDFLEX_E2E_EMAIL and GRIDFLEX_E2E_PASSWORD must be provided together.',
    );
  }
  if (suppliedEmail && suppliedPassword) return;

  const databaseUrl =
    process.env.GRIDFLEX_E2E_DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const target = new URL(databaseUrl);
  if (
    !['127.0.0.1', 'localhost'].includes(target.hostname) ||
    target.port !== '5433' ||
    target.pathname !== '/gridflex'
  ) {
    throw new Error(
      'Refusing to create a browser-test operator outside the disposable localhost:5433/gridflex database. Provide GRIDFLEX_E2E_EMAIL and GRIDFLEX_E2E_PASSWORD instead.',
    );
  }

  const seedEnv = { ...process.env, DATABASE_URL: databaseUrl };
  await runPnpm(['--filter', '@gridflex/db', 'run', 'db:migrate'], seedEnv);
  await runPnpm(
    ['--filter', '@gridflex/db', 'exec', 'tsx', 'scripts/seed.ts'],
    seedEnv,
  );

  const requireFromApi = createRequire(resolve(ROOT, 'apps/api/package.json'));
  const argon2 = requireFromApi('argon2');
  const pg = requireFromApi('pg');
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 8_000 });
  await client.connect();

  try {
    const facility = await client.query(
      `select id, organization_id
       from facilities
       where slug = 'lone-star-compute'
       limit 1`,
    );
    if (!facility.rows[0]) {
      throw new Error(
        'No pilot facility exists. Run the database migration and demo/pilot seed before the browser suite.',
      );
    }

    const passwordHash = await argon2.hash(LOCAL_PILOT.password, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 4,
    });
    const user = await client.query(
      `insert into app_users (email, display_name, password_hash, is_active)
       values ($1, 'Playwright Pilot Operator', $2, true)
       on conflict (email) do update
       set password_hash = excluded.password_hash,
           display_name = excluded.display_name,
           is_active = true,
           updated_at = now()
      returning id`,
      [LOCAL_PILOT.email, passwordHash],
    );
    await client.query(
      `delete from organization_members
       where user_id = $1 and organization_id <> $2`,
      [user.rows[0].id, facility.rows[0].organization_id],
    );
    await client.query(
      `insert into organization_members (organization_id, user_id, role)
       values ($1, $2, 'OWNER')
       on conflict (organization_id, user_id) do update set role = 'OWNER'`,
      [facility.rows[0].organization_id, user.rows[0].id],
    );

    const stalePasswordHash = await argon2.hash(STALE_TELEMETRY_PILOT.password, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 4,
    });
    const staleUser = await client.query(
      `insert into app_users (email, display_name, password_hash, is_active)
       values ($1, 'Playwright Stale Telemetry Operator', $2, true)
       on conflict (email) do update
       set password_hash = excluded.password_hash,
           display_name = excluded.display_name,
           is_active = true,
           updated_at = now()
       returning id`,
      [STALE_TELEMETRY_PILOT.email, stalePasswordHash],
    );

    await client.query('begin');
    try {
      await client.query(
        `insert into organizations (id, name, slug)
         values ($1, 'GridFlex Stale Telemetry Test', 'gridflex-stale-telemetry-test')
         on conflict (id) do update
         set name = excluded.name,
             slug = excluded.slug,
             updated_at = now()`,
        [STALE_TELEMETRY_PILOT.organizationId],
      );
      await client.query(
        `insert into facilities (
           id, organization_id, name, slug, timezone, country_code, region, market,
           normal_load_kw, minimum_safe_load_kw, maximum_curtailment_kw,
           ramp_rate_kw_per_min, cooling_reserve_kw, status, metadata
         ) values (
           $1, $2, 'Stale Telemetry Test Facility', 'stale-telemetry-test', 'UTC',
           'US', 'Test Region', 'SIM', 1000, 600, 300, 75, 100, 'ACTIVE',
           '{"e2e_fixture":true,"telemetry_state":"stale"}'::jsonb
         )
         on conflict (id) do update
         set organization_id = excluded.organization_id,
             name = excluded.name,
             slug = excluded.slug,
             normal_load_kw = excluded.normal_load_kw,
             minimum_safe_load_kw = excluded.minimum_safe_load_kw,
             maximum_curtailment_kw = excluded.maximum_curtailment_kw,
             ramp_rate_kw_per_min = excluded.ramp_rate_kw_per_min,
             cooling_reserve_kw = excluded.cooling_reserve_kw,
             status = excluded.status,
             metadata = excluded.metadata,
             updated_at = now()`,
        [
          STALE_TELEMETRY_PILOT.facilityId,
          STALE_TELEMETRY_PILOT.organizationId,
        ],
      );
      await client.query(
        `insert into facility_constraints (
           facility_id, version, effective_from, minimum_safe_load_kw,
           maximum_curtailment_kw, maximum_ramp_kw_per_min,
           maximum_duration_min, minimum_recovery_min, maximum_rebound_kw,
           thermal_limit_c, source_note
         ) values ($1, 1, '2000-01-01T00:00:00Z', 600, 300, 75, 60, 15, 150, 32,
           'Deterministic stale-telemetry browser fixture')
         on conflict (facility_id, version) do nothing`,
        [STALE_TELEMETRY_PILOT.facilityId],
      );
      await client.query(
        `insert into flexibility_mechanisms (
           id, facility_id, code, name, mechanism_type, enabled,
           declared_reducible_kw, ramp_rate_kw_per_min, maximum_duration_min,
           rebound_window_min, metadata
         ) values ($1, $2, 'E2E_DEFERRAL', 'E2E workload deferral', 'WORKLOAD', true,
           250, 50, 45, 20, '{"provenance":"DECLARED","e2e_fixture":true}'::jsonb)
         on conflict (facility_id, code) do update
         set name = excluded.name,
             mechanism_type = excluded.mechanism_type,
             enabled = excluded.enabled,
             declared_reducible_kw = excluded.declared_reducible_kw,
             ramp_rate_kw_per_min = excluded.ramp_rate_kw_per_min,
             maximum_duration_min = excluded.maximum_duration_min,
             rebound_window_min = excluded.rebound_window_min,
             metadata = excluded.metadata,
             updated_at = now()`,
        [
          STALE_TELEMETRY_PILOT.mechanismId,
          STALE_TELEMETRY_PILOT.facilityId,
        ],
      );
      await client.query(
        `insert into telemetry_readings (
           organization_id, facility_id, source_key, metric_key, measured_at,
           value_double, unit, quality, metadata
         ) values ($1, $2, 'e2e-stale-main-meter', 'facility.active_power_kw',
           '2000-01-01T00:00:00Z', 1000, 'kW', 'GOOD',
           '{"e2e_fixture":true,"expected_state":"stale"}'::jsonb)
         on conflict (facility_id, source_key, metric_key, measured_at) do nothing`,
        [
          STALE_TELEMETRY_PILOT.organizationId,
          STALE_TELEMETRY_PILOT.facilityId,
        ],
      );
      await client.query(
        `delete from organization_members
         where user_id = $1 and organization_id <> $2`,
        [staleUser.rows[0].id, STALE_TELEMETRY_PILOT.organizationId],
      );
      await client.query(
        `insert into organization_members (organization_id, user_id, role)
         values ($1, $2, 'OWNER')
         on conflict (organization_id, user_id) do update set role = 'OWNER'`,
        [STALE_TELEMETRY_PILOT.organizationId, staleUser.rows[0].id],
      );

      // A previous interrupted failure-path run must not leave the canonical
      // test facility latched. Its immutable drill/audit evidence is retained.
      await client.query(
        `update emergency_stop_events
         set cleared_at = now(),
             clear_note = coalesce(clear_note, 'Playwright fixture reset')
         where facility_id = $1 and cleared_at is null`,
        [LOCAL_PILOT.facilityId],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  } finally {
    await client.end();
  }

  await runPnpm(
    ['--filter', '@gridflex/db', 'exec', 'tsx', 'scripts/seed-simulation.ts'],
    seedEnv,
  );
}

async function runPnpm(args: string[], env: NodeJS.ProcessEnv) {
  try {
    await execFileAsync('pnpm', args, {
      cwd: ROOT,
      env,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Pilot database preparation failed: pnpm ${args.join(' ')}\n${detail}`);
  }
}
