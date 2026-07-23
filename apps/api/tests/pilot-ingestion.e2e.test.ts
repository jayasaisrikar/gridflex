/**
 * Pilot setup + ingestion integration tests.
 *
 * These run the real controllers and real PostgreSQL constraints. Authentication
 * is replaced with a fixed request identity so the suite stays focused on
 * organization scoping, encryption, versioning, and append-only ingestion.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { ErrorFilter } from '../src/common/errors/error.filter.js';
import { OrgScopeService } from '../src/common/auth/org-scope.service.js';
import { FacilitiesController } from '../src/modules/facilities/facilities.controller.js';
import { TelemetryController } from '../src/modules/telemetry/telemetry.controller.js';
import { ConnectorsController } from '../src/modules/connectors/connectors.controller.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://gridflex:gridflex@localhost:5433/gridflex';
if (/192\.168\.|coolify|xgpmainz/i.test(TEST_DATABASE_URL)) {
  throw new Error('Refusing to run destructive pilot tests against a non-disposable database.');
}
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.AUTH_SECRET ??= 'pilot-test-auth-secret-that-is-longer-than-32-characters';
process.env.CONNECTOR_ENCRYPTION_KEY ??=
  'pilot-test-connector-key-that-is-distinct-and-long-enough';

const RESETTABLE_TABLES = [
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
let connectorId: string;

async function request(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
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
  // Docker maps host 5433 to server 5432; current_database plus the URL guard
  // above identifies the disposable target without assuming its internal port.
  if (target.rows[0]?.db !== 'gridflex') {
    throw new Error(`Unexpected test database ${target.rows[0]?.db}:${target.rows[0]?.port}`);
  }
  await admin.query(`truncate ${RESETTABLE_TABLES.join(', ')} restart identity cascade`);
  const organization = await admin.query<{ id: string }>(
    `insert into organizations (name, slug) values ('Pilot Org', 'pilot-org') returning id`,
  );
  organizationId = organization.rows[0]!.id;
  const user = await admin.query<{ id: string }>(
    `insert into app_users (email, display_name, password_hash)
     values ('pilot-owner@test.local', 'Pilot Owner', 'unused-in-this-suite') returning id`,
  );
  userId = user.rows[0]!.id;
  await admin.query(
    `insert into organization_members (organization_id, user_id, role) values ($1, $2, 'OWNER')`,
    [organizationId, userId],
  );

  const moduleRef = await Test.createTestingModule({
    imports: [DatabaseModule],
    controllers: [FacilitiesController, TelemetryController, ConnectorsController],
    providers: [OrgScopeService],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ErrorFilter());
  app.getHttpAdapter().getInstance().addHook('preHandler', (rawRequest, _reply, done) => {
    const authenticated = rawRequest as typeof rawRequest & {
      gridflexUser?: { id: string; email: string };
    };
    authenticated.gridflexUser = { id: userId, email: 'pilot-owner@test.local' };
    done();
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('facility setup writes', () => {
  it('creates, updates, and versions pilot safety configuration', async () => {
    const created = await request('POST', '/api/v1/facilities', {
      name: 'DFW Pilot',
      slug: 'dfw-pilot',
      timezone: 'America/Chicago',
      country_code: 'us',
      normal_load_kw: '1600.000',
      minimum_safe_load_kw: '900.000',
      maximum_curtailment_kw: '600.000',
      ramp_rate_kw_per_min: '100.000',
      cooling_reserve_kw: '150.000',
    });
    expect(created.statusCode).toBe(201);
    facilityId = created.json().facility.id;
    expect(created.json().facility.country_code).toBe('US');
    expect(created.json().facility.organization_id).toBe(organizationId);

    const updated = await request('PATCH', `/api/v1/facilities/${facilityId}`, {
      region: 'ERCOT North',
      market: 'ERCOT',
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().facility.region).toBe('ERCOT North');

    for (const sourceNote of ['Commissioning baseline', 'Pilot safety review']) {
      const constraints = await request(
        'POST',
        `/api/v1/facilities/${facilityId}/constraints`,
        {
          minimum_safe_load_kw: '900.000',
          maximum_curtailment_kw: '600.000',
          maximum_ramp_kw_per_min: '100.000',
          maximum_duration_min: 30,
          minimum_recovery_min: 15,
          excluded_workloads: ['life-safety'],
          tenant_carve_outs: [],
          source_note: sourceNote,
        },
      );
      expect(constraints.statusCode).toBe(201);
    }
    const history = await request('GET', `/api/v1/facilities/${facilityId}/constraints`);
    expect(history.json().constraints.map((row: { version: number }) => row.version)).toEqual([2, 1]);

    const mechanism = await request(
      'POST',
      `/api/v1/facilities/${facilityId}/mechanisms`,
      {
        code: 'DEFER_BATCH',
        name: 'Defer batch compute',
        mechanism_type: 'WORKLOAD',
        declared_reducible_kw: '500.000',
        maximum_duration_min: 30,
      },
    );
    expect(mechanism.statusCode).toBe(201);
    await admin.query(
      `insert into envelopes
         (organization_id, facility_id, version, status, as_of, total_reducible_kw,
          response_time_seconds, sustainable_duration_min, aggregate_ramp_kw_per_min,
          confidence_score, telemetry_completeness, methodology_version, constraints_version)
       values ($1, $2, 1, 'CURRENT', now(), 500, 60, 30, 100, 0.9, 1, 'pilot-test', 2)`,
      [organizationId, facilityId],
    );
    const patched = await request(
      'PATCH',
      `/api/v1/facilities/${facilityId}/mechanisms/${mechanism.json().mechanism.id}`,
      { enabled: false },
    );
    expect(patched.json().mechanism.enabled).toBe(false);
    const stale = await admin.query<{ status: string }>(
      `select status from envelopes where facility_id = $1 and version = 1`,
      [facilityId],
    );
    expect(stale.rows[0]!.status).toBe('STALE');

    const audit = await admin.query<{ n: number }>(
      `select count(*)::int n from audit_logs where facility_id = $1`,
      [facilityId],
    );
    expect(audit.rows[0]!.n).toBeGreaterThanOrEqual(6);
  });

  it('rejects unsafe facility limits before persistence', async () => {
    const response = await request('PATCH', `/api/v1/facilities/${facilityId}`, {
      minimum_safe_load_kw: '1700.000',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('returns opaque not-found for a malformed facility id', async () => {
    const response = await request('GET', '/api/v1/facilities/not-a-uuid/telemetry');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(response.body).not.toMatch(/postgres|select /i);
  });
});

describe('connector lifecycle', () => {
  it('encrypts configuration, never returns it, and supports explicit testing', async () => {
    const created = await request('POST', `/api/v1/facilities/${facilityId}/connectors`, {
      name: 'Pilot CSV meter',
      connector_type: 'CSV_UPLOAD',
      configuration: { account_id: 'sensitive-account', api_token: 'super-secret-token' },
      poll_interval_seconds: 60,
    });
    expect(created.statusCode).toBe(201);
    connectorId = created.json().connector.id;
    expect(created.body).not.toContain('super-secret-token');
    expect(created.json().connector.config_summary.configured_fields).toEqual([
      'account_id',
      'api_token',
    ]);

    const stored = await admin.query<{ encrypted: Buffer; summary: object }>(
      `select configuration_encrypted encrypted, config_summary summary from connectors where id = $1`,
      [connectorId],
    );
    expect(stored.rows[0]!.encrypted.toString('utf8')).not.toContain('super-secret-token');
    expect(JSON.stringify(stored.rows[0]!.summary)).not.toContain('super-secret-token');

    const tested = await request('POST', `/api/v1/connectors/${connectorId}/test`);
    expect(tested.statusCode).toBe(201);
    expect(tested.json()).toMatchObject({ ok: true, status: 'ACTIVE' });
  });

  it('returns not-found for a malformed connector id instead of leaking a database error', async () => {
    const response = await request('GET', '/api/v1/connectors/not-a-uuid');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(response.body).not.toMatch(/postgres|select /i);
  });
});

describe('idempotent JSON telemetry ingestion', () => {
  const reading = {
    metric_key: 'facility.active_power_kw',
    measured_at: new Date(Date.now() - 10 * 60 * 1_000).toISOString(),
    value: '1600.25',
    unit: 'kW',
    quality: 'GOOD',
    source_sequence: '1',
  };

  it('inserts once, accepts an exact retry, and quarantines a conflicting retry', async () => {
    const url = `/api/v1/facilities/${facilityId}/telemetry/batch`;
    const payload = { source_key: 'pilot-meter', connector_id: connectorId, readings: [reading] };
    const first = await request('POST', url, payload);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ inserted: 1, duplicates: 0, quarantined: 0 });

    const retry = await request('POST', url, { ...payload, readings: [reading, reading] });
    expect(retry.json()).toMatchObject({ inserted: 0, duplicates: 2, quarantined: 0 });

    const conflict = await request('POST', url, {
      ...payload,
      readings: [
        { ...reading, value: '1500.00' },
        { ...reading, value: '1500.00' },
      ],
    });
    expect(conflict.json()).toMatchObject({ inserted: 0, duplicates: 0, quarantined: 2 });

    const stored = await admin.query<{ value: number }>(
      `select value_double value from telemetry_readings
       where facility_id = $1 and source_key = 'pilot-meter'`,
      [facilityId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.value).toBe(1600.25);
    const quarantine = await request(
      'GET',
      `/api/v1/facilities/${facilityId}/telemetry/quarantine`,
    );
    expect(quarantine.json().quarantine[0].reason_code).toBe('TELEMETRY_DUPLICATE_CONFLICT');
  });
});

describe('CSV preview and confirmation', () => {
  const validInstant = new Date(Date.now() - 8 * 60 * 1_000).toISOString();
  const unitMismatchInstant = new Date(Date.now() - 6 * 60 * 1_000).toISOString();
  const csv = [
    'measured_at,metric_key,value,unit,source_sequence',
    `${validInstant},facility.active_power_kw,1590.25,kW,2`,
    'not-a-time,facility.active_power_kw,1580.00,kW,3',
    `${unitMismatchInstant},facility.active_power_kw,1570.00,MW,4`,
  ].join('\n');

  it('binds confirmation to the previewed bytes and quarantines invalid rows', async () => {
    const url = `/api/v1/facilities/${facilityId}/telemetry/csv`;
    const payload = { source_key: 'pilot-csv', connector_id: connectorId, csv };
    const preview = await request('POST', url, payload);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ total_rows: 3, valid_rows: 1 });
    expect(preview.json().invalid_rows).toHaveLength(2);

    const tampered = await request('POST', url, {
      ...payload,
      csv: csv.replace('1590.25', '1400.00'),
      confirm: true,
      preview_token: preview.json().preview_token,
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json().error.code).toBe('VALIDATION_FAILED');

    const committed = await request('POST', url, {
      ...payload,
      confirm: true,
      preview_token: preview.json().preview_token,
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json()).toMatchObject({ inserted: 1, duplicates: 0, quarantined: 2 });
  });
});
