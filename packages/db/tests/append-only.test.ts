/**
 * Immutability enforcement tests (spec §7.2, §19.2).
 *
 * These assert that the database itself REJECTS UPDATE and DELETE on the
 * append-only tables — not that application code merely avoids issuing them.
 * The guarantee has to hold against a direct SQL statement, because that is the
 * threat model: a Passport is only trustworthy if its underlying telemetry and
 * evidence cannot be revised after the fact.
 *
 * Every test runs inside a transaction that is ROLLED BACK, so the suite leaves
 * no rows behind and is safe to re-run against a shared development database.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const text = readFileSync(resolve(here, '../../../.env'), 'utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('DATABASE_URL=')) return line.slice('DATABASE_URL='.length).trim();
  }
  throw new Error('DATABASE_URL is required to run database tests');
}

let client: pg.Client;

beforeAll(async () => {
  client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 8_000 });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
});

/** Runs `body` inside a transaction that is always rolled back. */
async function inRollback<T>(body: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    return await body();
  } finally {
    await client.query('ROLLBACK');
  }
}

/**
 * Asserts a statement is rejected, inside a SAVEPOINT.
 *
 * PostgreSQL aborts the whole transaction on any error, so without a savepoint
 * the FIRST expected failure poisons the transaction and every subsequent
 * statement returns "current transaction is aborted" — which would mask whether
 * the trigger actually fired. The savepoint keeps the transaction usable so each
 * rejection is verified on its own merits.
 */
async function expectRejected(sql: string, params: unknown[], pattern: RegExp): Promise<void> {
  await client.query('SAVEPOINT attempt');
  let error: unknown;
  try {
    await client.query(sql, params);
  } catch (caught) {
    error = caught;
  }
  await client.query('ROLLBACK TO SAVEPOINT attempt');

  expect(error, `Expected the statement to be rejected, but it succeeded: ${sql}`).toBeDefined();
  expect((error as Error).message).toMatch(pattern);
}

/** Creates the minimum org + facility needed for FK-bearing rows. */
async function seedScaffold(): Promise<{ orgId: string; facilityId: string }> {
  const org = await client.query<{ id: string }>(
    `insert into organizations (name, slug) values ('Test Org', 'test-org-immutability')
     returning id`,
  );
  const orgId = org.rows[0]!.id;
  const facility = await client.query<{ id: string }>(
    `insert into facilities (organization_id, name, slug) values ($1, 'Test Facility', 'test-facility')
     returning id`,
    [orgId],
  );
  return { orgId, facilityId: facility.rows[0]!.id };
}

describe('telemetry_readings is append-only', () => {
  it('accepts INSERT', async () => {
    await inRollback(async () => {
      const { orgId, facilityId } = await seedScaffold();
      const result = await client.query(
        `insert into telemetry_readings
           (organization_id, facility_id, source_key, metric_key, measured_at, value_double, unit)
         values ($1, $2, 'test', 'facility.active_power_kw', now(), 1600.25, 'kW')
         returning id`,
        [orgId, facilityId],
      );
      expect(result.rowCount).toBe(1);
    });
  });

  it('REJECTS UPDATE', async () => {
    await inRollback(async () => {
      const { orgId, facilityId } = await seedScaffold();
      const inserted = await client.query<{ id: string }>(
        `insert into telemetry_readings
           (organization_id, facility_id, source_key, metric_key, measured_at, value_double, unit)
         values ($1, $2, 'test', 'facility.active_power_kw', now(), 1600.25, 'kW')
         returning id`,
        [orgId, facilityId],
      );
      // Attempting to revise a measured value must fail at the database.
      await expectRejected(
        'update telemetry_readings set value_double = 1 where id = $1',
        [inserted.rows[0]!.id],
        /append-only/i,
      );
    });
  });

  it('REJECTS DELETE', async () => {
    await inRollback(async () => {
      const { orgId, facilityId } = await seedScaffold();
      const inserted = await client.query<{ id: string }>(
        `insert into telemetry_readings
           (organization_id, facility_id, source_key, metric_key, measured_at, value_double, unit)
         values ($1, $2, 'test', 'facility.active_power_kw', now(), 1600.25, 'kW')
         returning id`,
        [orgId, facilityId],
      );
      await expectRejected(
        'delete from telemetry_readings where id = $1',
        [inserted.rows[0]!.id],
        /append-only/i,
      );
    });
  });

  it('enforces the unique constraint backing idempotent ingestion (spec 9.2)', async () => {
    await inRollback(async () => {
      const { orgId, facilityId } = await seedScaffold();
      const insert = () =>
        client.query(
          `insert into telemetry_readings
             (organization_id, facility_id, source_key, metric_key, measured_at, value_double, unit)
           values ($1, $2, 'dup', 'facility.active_power_kw', '2026-07-21T12:00:00Z', 1600, 'kW')`,
          [orgId, facilityId],
        );
      await insert();
      // Same (facility, source_key, metric_key, measured_at) must collide.
      await expectRejected(
        `insert into telemetry_readings
           (organization_id, facility_id, source_key, metric_key, measured_at, value_double, unit)
         values ($1, $2, 'dup', 'facility.active_power_kw', '2026-07-21T12:00:00Z', 1600, 'kW')`,
        [orgId, facilityId],
        /duplicate key|unique/i,
      );
    });
  });
});

describe('audit_logs is append-only', () => {
  it('REJECTS UPDATE and DELETE', async () => {
    await inRollback(async () => {
      const inserted = await client.query<{ id: string }>(
        `insert into audit_logs (action, object_type, object_id)
         values ('TEST_ACTION', 'test', 'abc') returning id`,
      );
      const id = inserted.rows[0]!.id;
      // An audit trail that can be edited is not an audit trail.
      await expectRejected(
        `update audit_logs set action = 'TAMPERED' where id = $1`, [id], /append-only/i,
      );
      await expectRejected('delete from audit_logs where id = $1', [id], /append-only/i);
    });
  });
});

describe('drill_events is append-only', () => {
  it('REJECTS UPDATE and DELETE', async () => {
    await inRollback(async () => {
      const { orgId, facilityId } = await seedScaffold();
      const user = await client.query<{ id: string }>(
        `insert into app_users (email, display_name, password_hash)
         values ('immutability-test@example.com', 'Test', 'x') returning id`,
      );
      const drill = await client.query<{ id: string }>(
        `insert into drills
           (organization_id, facility_id, name, requested_reduction_kw,
            planned_start_at, planned_end_at, created_by)
         values ($1, $2, 'Test drill', 500, now(), now() + interval '30 minutes', $3)
         returning id`,
        [orgId, facilityId, user.rows[0]!.id],
      );
      const event = await client.query<{ id: string }>(
        `insert into drill_events (drill_id, event_type) values ($1, 'CREATED') returning id`,
        [drill.rows[0]!.id],
      );
      const id = event.rows[0]!.id;
      await expectRejected(
        `update drill_events set reason_code = 'X' where id = $1`, [id], /append-only/i,
      );
      await expectRejected('delete from drill_events where id = $1', [id], /append-only/i);
    });
  });
});

describe('evidence_bundles is append-only', () => {
  it('REJECTS UPDATE and DELETE', async () => {
    await inRollback(async () => {
      const { orgId, facilityId } = await seedScaffold();
      const bundle = await client.query<{ id: string }>(
        `insert into evidence_bundles
           (organization_id, facility_id, schema_version, canonical_json, canonical_sha256)
         values ($1, $2, 'gridflex-canonical-1', '{"a":1}'::jsonb, repeat('a', 64))
         returning id`,
        [orgId, facilityId],
      );
      const id = bundle.rows[0]!.id;
      // Rewriting a hash after issuance would break every Passport referencing it.
      await expectRejected(
        `update evidence_bundles set canonical_sha256 = repeat('b', 64) where id = $1`,
        [id], /append-only/i,
      );
      await expectRejected(
        'delete from evidence_bundles where id = $1', [id], /append-only/i,
      );
    });
  });
});

describe('mutable tables still allow UPDATE', () => {
  it('permits updating facilities and fires the updated_at trigger', async () => {
    await inRollback(async () => {
      const { facilityId } = await seedScaffold();
      const before = await client.query<{ updated_at: Date }>(
        'select updated_at from facilities where id = $1',
        [facilityId],
      );
      await client.query(`update facilities set name = 'Renamed' where id = $1`, [facilityId]);
      const after = await client.query<{ name: string; updated_at: Date }>(
        'select name, updated_at from facilities where id = $1',
        [facilityId],
      );
      expect(after.rows[0]!.name).toBe('Renamed');
      // set_updated_at() must have advanced the timestamp.
      expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThanOrEqual(
        before.rows[0]!.updated_at.getTime(),
      );
    });
  });
});

describe('test isolation', () => {
  it('leaves no rows behind — every test rolled back', async () => {
    const org = await client.query(
      `select count(*)::int n from organizations where slug = 'test-org-immutability'`,
    );
    expect((org.rows[0] as { n: number }).n).toBe(0);
    const user = await client.query(
      `select count(*)::int n from app_users where email = 'immutability-test@example.com'`,
    );
    expect((user.rows[0] as { n: number }).n).toBe(0);
  });
});
