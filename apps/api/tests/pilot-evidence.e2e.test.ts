/** Real PostgreSQL coverage for the pilot drill -> evidence -> Passport chain. */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { ErrorFilter } from '../src/common/errors/error.filter.js';
import { OrgScopeService } from '../src/common/auth/org-scope.service.js';
import { DrillsController } from '../src/modules/drills/drills.controller.js';
import { PassportsController } from '../src/modules/passports/passports.controller.js';
import { AuditController } from '../src/modules/audit/audit.controller.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://gridflex:gridflex@localhost:5433/gridflex';
if (/192\.168\.|coolify|xgpmainz/i.test(TEST_DATABASE_URL)) {
  throw new Error('Refusing to run destructive evidence tests against a non-disposable database.');
}
const testDatabaseTarget = new URL(TEST_DATABASE_URL);
if (
  !['localhost', '127.0.0.1'].includes(testDatabaseTarget.hostname) ||
  testDatabaseTarget.port !== '5433'
) {
  throw new Error('Evidence tests require the disposable localhost database on port 5433.');
}
process.env.DATABASE_URL = TEST_DATABASE_URL;

const RESETTABLE_TABLES = [
  'export_packages',
  'passports',
  'evidence_bundles',
  'mrv_reports',
  'drill_events',
  'drill_arm_challenges',
  'emergency_stop_events',
  'drills',
  'envelope_mechanisms',
  'envelopes',
  'engine_decisions',
  'engine_runs',
  'telemetry_quarantine',
  'telemetry_readings',
  'connector_sync_runs',
  'connectors',
  'facility_constraints',
  'flexibility_mechanisms',
  'facilities',
  'organization_members',
  'audit_logs',
  'app_users',
  'organizations',
];

let app: NestFastifyApplication;
let admin: pg.Client;
let userId: string;
let organizationId: string;
let facilityId: string;
let envelopeId: string;
let drillId: string;
let accessChallenge: { challenge_id: string; confirmation_phrase: string };
let passportId: string;
let passportSha256: string;

async function request(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  const target = await admin.query<{ db: string; port: string }>(
    `select current_database() as db, inet_server_port()::text as port`,
  );
  // Docker publishes host 5433 to PostgreSQL's internal 5432.
  if (target.rows[0]?.db !== 'gridflex' || target.rows[0]?.port !== '5432') {
    throw new Error(`Unexpected test database ${target.rows[0]?.db}:${target.rows[0]?.port}`);
  }
  await admin.query(`truncate ${RESETTABLE_TABLES.join(', ')} restart identity cascade`);

  const organization = await admin.query<{ id: string }>(
    `insert into organizations (name, slug) values ('Evidence Pilot', 'evidence-pilot') returning id`,
  );
  organizationId = organization.rows[0]!.id;
  const user = await admin.query<{ id: string }>(
    `insert into app_users (email, display_name, password_hash)
     values ('evidence-owner@test.local', 'Evidence Owner', 'unused') returning id`,
  );
  userId = user.rows[0]!.id;
  await admin.query(
    `insert into organization_members (organization_id, user_id, role)
     values ($1, $2, 'OWNER')`,
    [organizationId, userId],
  );
  const facility = await admin.query<{ id: string }>(
    `insert into facilities
       (organization_id, name, slug, timezone, region, market, normal_load_kw,
        minimum_safe_load_kw, maximum_curtailment_kw, ramp_rate_kw_per_min)
     values ($1, '=Evidence Pilot Facility', 'evidence-facility', 'UTC', 'Texas', 'ERCOT',
             1600, 900, 600, 100)
     returning id`,
    [organizationId],
  );
  facilityId = facility.rows[0]!.id;
  await admin.query(
    `insert into facility_constraints
       (facility_id, version, minimum_safe_load_kw, maximum_curtailment_kw,
        maximum_ramp_kw_per_min, maximum_duration_min, excluded_workloads, created_by)
     values ($1, 1, 900, 600, 100, 60, '["life-safety"]'::jsonb, $2)`,
    [facilityId, userId],
  );
  const mechanism = await admin.query<{ id: string }>(
    `insert into flexibility_mechanisms
       (facility_id, code, name, mechanism_type, declared_reducible_kw,
        ramp_rate_kw_per_min, maximum_duration_min)
     values ($1, 'DEFER_BATCH', 'Defer batch compute', 'WORKLOAD', 500, 100, 30)
     returning id`,
    [facilityId],
  );
  const connector = await admin.query<{ id: string }>(
    `insert into connectors
       (facility_id, name, connector_type, status, last_sync_at, last_success_at)
     values ($1, 'Pilot simulator', 'SIMULATOR', 'ACTIVE', now(), now()) returning id`,
    [facilityId],
  );
  await admin.query(
    `insert into telemetry_readings
       (organization_id, facility_id, connector_id, source_key, metric_key,
        measured_at, value_double, unit, quality, source_sequence)
     select $1, $2, $3, 'evidence-simulator', 'facility.active_power_kw',
            date_trunc('minute', now()) - interval '1439 minutes' + g * interval '1 minute',
            1600 - (g % 8), 'kW', 'GOOD', g::text
     from generate_series(0, 1439) as g`,
    [organizationId, facilityId, connector.rows[0]!.id],
  );
  const envelope = await admin.query<{ id: string }>(
    `insert into envelopes
       (organization_id, facility_id, version, status, as_of, total_reducible_kw,
        response_time_seconds, sustainable_duration_min, aggregate_ramp_kw_per_min,
        confidence_score, telemetry_completeness, methodology_version,
        constraints_version, blocked_reasons)
     values ($1, $2, 1, 'CURRENT', now(), 500, 300, 30, 100, 0.85, 1.0,
             'gridflex-envelope-v1', 1, '[]'::jsonb)
     returning id`,
    [organizationId, facilityId],
  );
  envelopeId = envelope.rows[0]!.id;
  await admin.query(
    `insert into envelope_mechanisms
       (envelope_id, mechanism_id, provenance, reducible_kw, response_time_seconds,
        ramp_kw_per_min, duration_min, confidence_score, evidence_refs)
     values ($1, $2, 'TESTED', 500, 300, 100, 30, 0.85, '[]'::jsonb)`,
    [envelopeId, mechanism.rows[0]!.id],
  );

  const moduleRef = await Test.createTestingModule({
    imports: [DatabaseModule],
    controllers: [DrillsController, PassportsController, AuditController],
    providers: [OrgScopeService],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ErrorFilter());
  app.getHttpAdapter().getInstance().addHook('preHandler', (rawRequest, _reply, done) => {
    const authenticated = rawRequest as typeof rawRequest & {
      gridflexUser?: { id: string; email: string };
    };
    authenticated.gridflexUser = { id: userId, email: 'evidence-owner@test.local' };
    done();
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('operator-approved drill chain', () => {
  it('rejects malformed UUIDs at the boundary rather than reaching PostgreSQL', async () => {
    const response = await request('GET', '/api/v1/drills/not-a-uuid');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    expect(response.body).not.toMatch(/postgres|invalid input syntax|select /i);
  });

  it('creates and validates a simulated pilot drill', async () => {
    const start = new Date(Date.now() + 10 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const created = await request('POST', `/api/v1/facilities/${facilityId}/drills`, {
      name: '500 kW pilot evidence drill',
      requested_reduction_kw: '500.000',
      planned_ramp_kw_per_min: '100.000',
      planned_start_at: start.toISOString(),
      planned_end_at: end.toISOString(),
      envelope_id: envelopeId,
      simulation_mode: true,
    });
    expect(created.statusCode).toBe(201);
    drillId = created.json().drill.id;
    expect(created.json().drill.status).toBe('DRAFT');

    const validated = await request('POST', `/api/v1/drills/${drillId}/validate`);
    expect(validated.json()).toMatchObject({ previous_status: 'DRAFT', status: 'READY' });
  });

  it('enforces typed, operator-bound, expiring, single-use two-step arming', async () => {
    const intent = await request('POST', `/api/v1/drills/${drillId}/arm-intent`);
    expect(intent.statusCode).toBe(201);
    expect(intent.json().warnings).toContainEqual(
      expect.objectContaining({ code: 'SIMULATION_MODE' }),
    );
    accessChallenge = intent.json();

    const mismatch = await request('POST', `/api/v1/drills/${drillId}/arm-confirm`, {
      challenge_id: accessChallenge.challenge_id,
      confirmation_phrase: 'ARM something else',
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe('ARM_CONFIRMATION_MISMATCH');

    await admin.query('update facilities set normal_load_kw = 1590 where id = $1', [facilityId]);
    const changedAfterReview = await request(
      'POST',
      `/api/v1/drills/${drillId}/arm-confirm`,
      {
        challenge_id: accessChallenge.challenge_id,
        confirmation_phrase: accessChallenge.confirmation_phrase,
      },
    );
    expect(changedAfterReview.statusCode).toBe(409);
    expect(changedAfterReview.json().error.message).toMatch(/changed after review/i);
    await admin.query('update facilities set normal_load_kw = 1600 where id = $1', [facilityId]);

    const refreshed = await request('POST', `/api/v1/drills/${drillId}/arm-intent`);
    accessChallenge = refreshed.json();
    const armed = await request('POST', `/api/v1/drills/${drillId}/arm-confirm`, {
      challenge_id: accessChallenge.challenge_id,
      confirmation_phrase: accessChallenge.confirmation_phrase,
    });
    expect(armed.json()).toMatchObject({ previous_status: 'READY', status: 'ARMED' });

    const replay = await request('POST', `/api/v1/drills/${drillId}/arm-confirm`, {
      challenge_id: accessChallenge.challenge_id,
      confirmation_phrase: accessChallenge.confirmation_phrase,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('ARM_CHALLENGE_CONSUMED');
  });

  it('stops into VERIFYING and generates labelled simulation MRV evidence atomically', async () => {
    const started = await request('POST', `/api/v1/drills/${drillId}/start`);
    expect(started.json().status).toBe('RUNNING');
    const stopped = await request('POST', `/api/v1/drills/${drillId}/stop`);
    expect(stopped.json()).toMatchObject({ previous_status: 'RUNNING', status: 'VERIFYING' });

    const detail = await request('GET', `/api/v1/drills/${drillId}`);
    expect(detail.json().drill.status).toBe('VERIFYING');
    expect(detail.json().mrv).toMatchObject({
      methodology_version: 'gridflex-mrv-1.0.0',
      telemetry_completeness: 1,
      maximum_gap_intervals: 0,
    });
    expect(detail.json().mrv.performance_bps).toBeGreaterThanOrEqual(9_600);
    expect(detail.json().evidence.canonical_sha256).toMatch(/^[0-9a-f]{64}$/);

    // A legacy/imported VERIFYING row still cannot claim completion without the
    // same MRV + evidence prerequisites.
    const incomplete = await admin.query<{ id: string }>(
      `insert into drills
         (organization_id, facility_id, envelope_id, name, status,
          requested_reduction_kw, planned_start_at, planned_end_at,
          simulation_mode, created_by)
       values ($1, $2, $3, 'Incomplete imported drill', 'VERIFYING', 100,
               now() - interval '10 minutes', now(), true, $4)
       returning id`,
      [organizationId, facilityId, envelopeId, userId],
    );
    const premature = await request(
      'POST',
      `/api/v1/drills/${incomplete.rows[0]!.id}/verify`,
    );
    expect(premature.statusCode).toBe(409);
    expect(premature.json().error.code).toBe('MRV_NOT_GENERATED');
    const stored = await admin.query<{ status: string }>(
      'select status from drills where id = $1',
      [incomplete.rows[0]!.id],
    );
    expect(stored.rows[0]!.status).toBe('VERIFYING');
    await admin.query("update drills set status = 'FAILED' where id = $1", [
      incomplete.rows[0]!.id,
    ]);
  });

  it('completes only after MRV and canonical evidence verify together', async () => {
    const verified = await request('POST', `/api/v1/drills/${drillId}/verify`);
    expect(verified.json()).toMatchObject({ previous_status: 'VERIFYING', status: 'COMPLETED' });

    const events = await request('GET', `/api/v1/drills/${drillId}/events`);
    expect(events.json().events.map((event: { event_type: string }) => event.event_type)).toEqual([
      'CREATED',
      'VALIDATED',
      'ARMED',
      'STARTED',
      'COMPLETED',
      'MRV_GENERATED',
      'COMPLETED',
    ]);
  });

  it('preempts a running drill with one facility stop record and supports explicit clearing', async () => {
    const start = new Date(Date.now() + 10 * 60 * 1000);
    const end = new Date(start.getTime() + 10 * 60 * 1000);
    const created = await request('POST', `/api/v1/facilities/${facilityId}/drills`, {
      name: 'Emergency-stop exercise',
      requested_reduction_kw: '100.000',
      planned_ramp_kw_per_min: '50.000',
      planned_start_at: start.toISOString(),
      planned_end_at: end.toISOString(),
      envelope_id: envelopeId,
      simulation_mode: true,
    });
    const stoppedDrillId = created.json().drill.id;
    await request('POST', `/api/v1/drills/${stoppedDrillId}/validate`);
    const intent = await request('POST', `/api/v1/drills/${stoppedDrillId}/arm-intent`);
    await request('POST', `/api/v1/drills/${stoppedDrillId}/arm-confirm`, {
      challenge_id: intent.json().challenge_id,
      confirmation_phrase: intent.json().confirmation_phrase,
    });
    await request('POST', `/api/v1/drills/${stoppedDrillId}/start`);

    const hardwareStop = await admin.query<{ id: string }>(
      `insert into emergency_stop_events (facility_id, reason_code, reason_detail)
       values ($1, 'HARDWARE_ESTOP', 'Pilot panel input') returning id`,
      [facilityId],
    );
    const stopped = await request(
      'POST',
      `/api/v1/drills/${stoppedDrillId}/emergency-stop`,
      { reason_code: 'OPERATOR_CONFIRMED', reason_detail: 'Panel stop observed' },
    );
    expect(stopped.json()).toMatchObject({
      emergency_stop_id: hardwareStop.rows[0]!.id,
      status: 'ABORTED',
    });
    const active = await admin.query<{ n: number }>(
      `select count(*)::int n from emergency_stop_events
       where facility_id = $1 and cleared_at is null`,
      [facilityId],
    );
    expect(active.rows[0]!.n).toBe(1);

    const cleared = await request(
      'POST',
      `/api/v1/facilities/${facilityId}/emergency-stop/clear`,
      { clear_note: 'Panel reset and operator walk-down complete' },
    );
    expect(cleared.json()).toMatchObject({
      cleared: true,
      emergency_stop_id: hardwareStop.rows[0]!.id,
    });
  });
});

describe('Passport, verification, export, and reviewer feed', () => {
  it('issues a labelled immutable Passport from the verified drill', async () => {
    const response = await request(
      'POST',
      `/api/v1/facilities/${facilityId}/passports/issue`,
      { envelope_id: envelopeId, drill_id: drillId, notes: 'Pilot issue' },
    );
    expect(response.statusCode).toBe(201);
    const passport = response.json().passport;
    passportId = passport.document.id;
    passportSha256 = passport.passport_sha256;
    expect(passport.status).toBe('ISSUED');
    expect(passport.passport_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(passport.document.evidence_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(passport.document.data_quality.contains_simulated_data).toBe(true);
    expect(passport.document.limitations.join(' ')).toMatch(/simulated data/i);
  });

  it('independently recomputes both stored hashes', async () => {
    const verified = await request('GET', `/api/v1/passports/${passportId}/verify`);
    expect(verified.json()).toMatchObject({
      passport_hash_matches: true,
      evidence_hash_matches: true,
    });
  });

  it('creates and retrieves deterministic JSON and formula-safe CSV exports', async () => {
    for (const format of ['JSON', 'CSV']) {
      const created = await request('POST', `/api/v1/passports/${passportId}/exports`, {
        format,
        counterparty_name: 'Pilot reviewer',
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().export.status).toBe('READY');
      const downloaded = await request('GET', created.json().download_url);
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.json().content).toContain('passport_sha256');
      if (format === 'CSV') {
        expect(downloaded.json().content).toContain("'=Evidence Pilot Facility");
      }
    }
  });

  it('supersedes lifecycle metadata without rewriting the prior issued document', async () => {
    const second = await request(
      'POST',
      `/api/v1/facilities/${facilityId}/passports/issue`,
      { envelope_id: envelopeId, drill_id: drillId, notes: 'Second pilot issue' },
    );
    expect(second.statusCode).toBe(201);
    expect(second.json().passport.document.version).toBe(2);

    const versions = await request('GET', `/api/v1/facilities/${facilityId}/passports`);
    expect(
      versions.json().passports.map((passport: { version: number; status: string }) => ({
        version: passport.version,
        status: passport.status,
      })),
    ).toEqual([
      { version: 2, status: 'ISSUED' },
      { version: 1, status: 'SUPERSEDED' },
    ]);
    const original = await request('GET', `/api/v1/passports/${passportId}`);
    expect(original.json().passport.passport_sha256).toBe(passportSha256);
    const originalVerification = await request('GET', `/api/v1/passports/${passportId}/verify`);
    expect(originalVerification.json()).toMatchObject({
      status: 'SUPERSEDED',
      passport_hash_matches: true,
      evidence_hash_matches: true,
    });
  });

  it('blocks issuance when a newer active safety version makes the envelope stale', async () => {
    await admin.query(
      `insert into facility_constraints
         (facility_id, version, minimum_safe_load_kw, maximum_curtailment_kw,
          maximum_ramp_kw_per_min, maximum_duration_min, excluded_workloads, created_by)
       values ($1, 2, 925, 575, 90, 45, '["life-safety"]'::jsonb, $2)`,
      [facilityId, userId],
    );
    const blocked = await request(
      'POST',
      `/api/v1/facilities/${facilityId}/passports/issue`,
      { envelope_id: envelopeId, drill_id: drillId },
    );
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('PASSPORT_BLOCKED');
    expect(blocked.json().error.message).toMatch(/recompute the envelope/i);
  });

  it('exposes correlated audit and immutable drill events to reviewers', async () => {
    const audit = await request('GET', `/api/v1/facilities/${facilityId}/audit?limit=100`);
    const actions = audit.json().entries.map((entry: { action: string }) => entry.action);
    expect(actions).toContain('DRILL_ARMED');
    expect(actions).toContain('PASSPORT_ISSUED');
    expect(actions).toContain('PASSPORT_EXPORT_CREATED');

    const activity = await request('GET', `/api/v1/facilities/${facilityId}/activity?limit=100`);
    const sources = new Set(
      activity.json().entries.map((entry: { source: string }) => entry.source),
    );
    expect(sources).toEqual(new Set(['AUDIT', 'DRILL_EVENT']));
  });
});
