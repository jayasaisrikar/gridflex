import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@gridflex/db/client';
import type { Database } from '@gridflex/db/client';
import { DATABASE } from '../src/common/database/database.module.js';
import { ErrorFilter } from '../src/common/errors/error.filter.js';
import { OrgScopeService } from '../src/common/auth/org-scope.service.js';
import { DrillsController } from '../src/modules/drills/drills.controller.js';
import { EnvelopesController } from '../src/modules/envelopes/envelopes.controller.js';
import { loadDataWindow } from '../src/modules/passports/passports.controller.js';
import { TelemetryController } from '../src/modules/telemetry/telemetry.controller.js';

const NOW = new Date('2026-07-23T12:00:30.000Z');
const USER_ID = '10000000-0000-4000-8000-000000000001';
const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000002';
const FACILITY_ID = '10000000-0000-4000-8000-000000000003';
const RUN_ID = '10000000-0000-4000-8000-000000000004';
const ENVELOPE_ID = '10000000-0000-4000-8000-000000000005';

type SelectStep = {
  readonly terminal:
    | 'leftJoinWhereOrder'
    | 'whereLimit'
    | 'whereOrderLimit'
    | 'whereOrder'
    | 'where';
  readonly result: readonly unknown[];
  readonly onWhere?: (condition: SQL) => void;
  readonly onOrderBy?: (expressions: readonly SQL[]) => void;
  readonly onLimit?: (limit: number) => void;
};

function createReadDatabase(steps: readonly SelectStep[]) {
  let cursor = 0;
  const select = vi.fn(() => {
    const step = steps[cursor++];
    if (!step) throw new Error(`Unexpected select call ${cursor}`);

    const where = (condition: SQL) => {
      step.onWhere?.(condition);
      switch (step.terminal) {
        case 'leftJoinWhereOrder':
        case 'whereOrder':
          return { orderBy: vi.fn().mockResolvedValue(step.result) };
        case 'whereOrderLimit':
          return {
            orderBy: vi.fn((...expressions: SQL[]) => {
              step.onOrderBy?.(expressions);
              return {
                limit: vi.fn((limit: number) => {
                  step.onLimit?.(limit);
                  return Promise.resolve(step.result);
                }),
              };
            }),
          };
        case 'whereLimit':
          return { limit: vi.fn().mockResolvedValue(step.result) };
        case 'where':
          return Promise.resolve(step.result);
      }
    };

    const from = vi.fn(() =>
      step.terminal === 'leftJoinWhereOrder'
        ? { leftJoin: vi.fn(() => ({ where })) }
        : { where },
    );
    return { from };
  });

  return {
    select,
    transaction: vi.fn(),
  };
}

function createScope() {
  return {
    requireFacility: vi.fn().mockResolvedValue({ organizationId: ORGANIZATION_ID }),
  };
}

function facility() {
  return {
    id: FACILITY_ID,
    normalLoadKw: '1600.000',
  };
}

function constraints() {
  return {
    id: '10000000-0000-4000-8000-000000000006',
    facilityId: FACILITY_ID,
    version: 3,
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    effectiveTo: null,
    minimumSafeLoadKw: '900.000',
    maximumCurtailmentKw: '600.000',
    maximumRampKwPerMin: '100.000',
    maximumDurationMin: 60,
    createdAt: '2026-07-01T00:00:00.000Z',
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('telemetry quality safety', () => {
  it('caps a dense series to its newest 5,000 samples and returns them chronologically', async () => {
    const start = new Date('2026-07-23T00:00:00.000Z');
    const newestFirstRows = Array.from({ length: 5_001 }, (_, offset) => {
      const sampleIndex = 5_000 - offset;
      return {
        measuredAt: new Date(start.getTime() + sampleIndex * 1_000).toISOString(),
        value: String(sampleIndex),
        unit: 'kW',
        quality: 'GOOD',
        sourceKey: 'dense-meter',
      };
    });
    let seriesOrderBy: readonly SQL[] | undefined;
    let seriesLimit: number | undefined;
    const db = createReadDatabase([
      {
        terminal: 'whereOrderLimit',
        result: newestFirstRows,
        onOrderBy: (expressions) => {
          seriesOrderBy = expressions;
        },
        onLimit: (limit) => {
          seriesLimit = limit;
        },
      },
    ]);
    const controller = new TelemetryController(
      db as unknown as Database,
      createScope() as unknown as OrgScopeService,
    );

    const series = await controller.series(
      USER_ID,
      FACILITY_ID,
      'facility.active_power_kw',
      '2026-07-23T00:00:00.000Z',
      '2026-07-23T02:00:00.000Z',
    );

    expect(seriesLimit).toBe(5_001);
    expect(series.truncated).toBe(true);
    expect(series.points).toHaveLength(5_000);
    expect(series.points[0]).toMatchObject({
      measured_at: '2026-07-23T00:00:01Z',
      value: '1',
    });
    expect(series.points.at(-1)).toMatchObject({
      measured_at: '2026-07-23T01:23:20Z',
      value: '5000',
    });

    const orderQuery = new PgDialect().sqlToQuery(seriesOrderBy![0]!);
    expect(orderQuery.sql).toContain('"telemetry_readings"."measured_at" desc');
  });

  it('counts only GOOD/ESTIMATED interval buckets and deduplicates redundant sources within a minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let qualityWhere: SQL | undefined;
    const db = createReadDatabase([
      {
        terminal: 'leftJoinWhereOrder',
        onWhere: (condition) => {
          qualityWhere = condition;
        },
        result: [
          {
            measuredAt: '2026-07-23T11:58:10.000Z',
            quality: 'GOOD',
            sourceKey: 'meter-a',
            connectorType: 'BACNET',
          },
          {
            measuredAt: '2026-07-23T11:59:05.000Z',
            quality: 'GOOD',
            sourceKey: 'meter-a',
            connectorType: 'BACNET',
          },
          {
            measuredAt: '2026-07-23T11:59:55.000Z',
            quality: 'ESTIMATED',
            sourceKey: 'meter-b',
            connectorType: 'MODBUS',
          },
          {
            measuredAt: '2026-07-23T12:00:20.000Z',
            quality: 'SUSPECT',
            sourceKey: 'simulator-rejected',
            connectorType: 'SIMULATOR',
          },
          {
            measuredAt: '2026-07-23T11:57:10.000Z',
            quality: 'MISSING',
            sourceKey: 'meter-c',
            connectorType: 'BACNET',
          },
        ],
      },
    ]);
    const scope = createScope();
    const controller = new TelemetryController(
      db as unknown as Database,
      scope as unknown as OrgScopeService,
    );

    const summary = await controller.quality(USER_ID, FACILITY_ID, '1', '60');

    expect(summary.observed_intervals).toBe(2);
    expect(summary.completeness).toBe(0.0333);
    expect(summary.last_reading_at).toBe('2026-07-23T11:59:55Z');
    expect(summary.is_stale).toBe(false);
    expect(summary.contains_simulated_data).toBe(false);

    const query = new PgDialect().sqlToQuery(qualityWhere!);
    expect(query.sql).toContain('"telemetry_readings"."quality" in');
    expect(query.params).toEqual(expect.arrayContaining(['GOOD', 'ESTIMATED']));
  });
});

describe('drill telemetry safety', () => {
  it('accepts only GOOD/ESTIMATED active-power intervals and blocks on SUSPECT thermal data', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let activePowerWhere: SQL | undefined;
    const db = createReadDatabase([
      { terminal: 'whereLimit', result: [facility()] },
      {
        terminal: 'whereOrderLimit',
        result: [{ ...constraints(), thermalLimitC: '40.000' }],
      },
      {
        terminal: 'whereLimit',
        result: [
          {
            id: ENVELOPE_ID,
            status: 'CURRENT',
            constraintsVersion: 3,
            validUntil: '2026-07-23T13:00:00.000Z',
            responseTimeSeconds: 60,
            totalReducibleKw: '500.000',
          },
        ],
      },
      {
        terminal: 'where',
        result: [{ count: '1440', lastReadingAt: '2026-07-23T12:00:00.000Z' }],
        onWhere: (condition) => {
          activePowerWhere = condition;
        },
      },
      { terminal: 'whereLimit', result: [] },
      { terminal: 'whereLimit', result: [] },
      {
        terminal: 'whereOrderLimit',
        result: [{ value: '30.000', quality: 'SUSPECT' }],
      },
    ]);
    const controller = new DrillsController(
      db as unknown as Database,
      createScope() as unknown as OrgScopeService,
    );
    const operationContext = (
      controller as unknown as {
        operationContext(
          tx: Database,
          drill: typeof schema.drills.$inferSelect,
        ): Promise<{
          safety: {
            telemetryCompleteness: number;
            telemetryStale: boolean;
            thermalLimitExceeded: boolean;
            envelopeCurrent: boolean;
          };
        }>;
      }
    ).operationContext.bind(controller);

    const context = await operationContext(
      db as unknown as Database,
      {
        id: '10000000-0000-4000-8000-000000000007',
        facilityId: FACILITY_ID,
        envelopeId: ENVELOPE_ID,
        requestedReductionKw: '300.000',
        maximumRampKwPerMin: '50.000',
        plannedStartAt: '2026-07-23T12:10:00.000Z',
        plannedEndAt: '2026-07-23T12:40:00.000Z',
      } as unknown as typeof schema.drills.$inferSelect,
    );

    expect(context.safety).toMatchObject({
      telemetryCompleteness: 1,
      telemetryStale: false,
      thermalLimitExceeded: true,
      envelopeCurrent: true,
    });

    const query = new PgDialect().sqlToQuery(activePowerWhere!);
    expect(query.sql).toContain('"telemetry_readings"."quality" in');
    expect(query.params).toEqual(expect.arrayContaining(['GOOD', 'ESTIMATED']));
    expect(query.params).not.toContain('SUSPECT');
  });
});

describe('passport data-window safety', () => {
  it('counts only GOOD/ESTIMATED active-power intervals', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let dataWindowWhere: SQL | undefined;
    const db = createReadDatabase([
      {
        terminal: 'where',
        result: [
          {
            windowStart: '2026-07-23T11:58:00.000Z',
            windowEnd: '2026-07-23T11:59:00.000Z',
            observedIntervals: 2,
          },
        ],
        onWhere: (condition) => {
          dataWindowWhere = condition;
        },
      },
    ]);

    const dataWindow = await loadDataWindow(
      db as unknown as Database,
      FACILITY_ID,
      NOW.toISOString(),
    );

    expect(dataWindow).toEqual({
      windowStart: '2026-07-23T11:58:00Z',
      windowEnd: '2026-07-23T11:59:00Z',
      observedIntervals: 2,
      completeness: 2 / 1_440,
    });

    const query = new PgDialect().sqlToQuery(dataWindowWhere!);
    expect(query.sql).toContain('"telemetry_readings"."quality" in');
    expect(query.params).toEqual(expect.arrayContaining(['GOOD', 'ESTIMATED']));
    expect(query.params).not.toContain('SUSPECT');
  });
});

describe('envelope recompute safety', () => {
  it('queries only constraints active at the recompute instant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let constraintsWhere: SQL | undefined;
    const db = createReadDatabase([
      { terminal: 'whereLimit', result: [facility()] },
      {
        terminal: 'whereOrderLimit',
        result: [],
        onWhere: (condition) => {
          constraintsWhere = condition;
        },
      },
    ]);
    const controller = new EnvelopesController(
      db as unknown as Database,
      createScope() as unknown as OrgScopeService,
    );

    await expect(controller.recompute(USER_ID, FACILITY_ID)).rejects.toMatchObject({
      code: 'CONSTRAINTS_MISSING',
      httpStatus: 409,
    });

    const query = new PgDialect().sqlToQuery(constraintsWhere!);
    expect(query.sql).toContain('"facility_constraints"."effective_from" <=');
    expect(query.sql).toContain('"facility_constraints"."effective_to" is null');
    expect(query.sql).toContain('"facility_constraints"."effective_to" >');
    expect(query.params).toEqual([
      FACILITY_ID,
      NOW.toISOString(),
      NOW.toISOString(),
    ]);
  });

  it('blocks recompute before any transaction when the latest accepted telemetry is stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = createReadDatabase([
      { terminal: 'whereLimit', result: [facility()] },
      { terminal: 'whereOrderLimit', result: [constraints()] },
      { terminal: 'whereOrder', result: [] },
      {
        terminal: 'where',
        result: [{ count: '1440', latest: '2026-07-23T11:55:00.000Z' }],
      },
    ]);
    const controller = new EnvelopesController(
      db as unknown as Database,
      createScope() as unknown as OrgScopeService,
    );

    await expect(controller.recompute(USER_ID, FACILITY_ID)).rejects.toMatchObject({
      code: 'ENVELOPE_BLOCKED_DATA_QUALITY',
      httpStatus: 409,
      details: { last_reading_at: '2026-07-23T11:55:00.000Z' },
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('records a blocked attempt without superseding the prior CURRENT envelope', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = createReadDatabase([
      { terminal: 'whereLimit', result: [facility()] },
      { terminal: 'whereOrderLimit', result: [constraints()] },
      { terminal: 'whereOrder', result: [] },
      {
        terminal: 'where',
        result: [{ count: '1440', latest: '2026-07-23T12:00:00.000Z' }],
      },
    ]);
    const priorCurrent = { status: 'CURRENT' };
    let insertedEnvelope: Record<string, unknown> | undefined;
    let txSelectCall = 0;
    const tx = {
      insert: vi.fn((table: unknown) => {
        if (table === schema.engineRuns) {
          return {
            values: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{ id: RUN_ID }]),
            })),
          };
        }
        if (table === schema.engineDecisions || table === schema.auditLogs) {
          return { values: vi.fn().mockResolvedValue(undefined) };
        }
        if (table === schema.envelopes) {
          return {
            values: vi.fn((values: Record<string, unknown>) => {
              insertedEnvelope = values;
              return {
                returning: vi.fn().mockResolvedValue([
                  {
                    ...values,
                    id: ENVELOPE_ID,
                    validUntil: null,
                    reboundPeakKw: null,
                    createdAt: NOW.toISOString(),
                  },
                ]),
              };
            }),
          };
        }
        throw new Error('Unexpected transaction insert target');
      }),
      update: vi.fn(() => ({
        set: vi.fn((values: { status: string }) => ({
          where: vi.fn(async () => {
            priorCurrent.status = values.status;
          }),
        })),
      })),
      select: vi.fn(() => {
        txSelectCall += 1;
        if (txSelectCall === 1) {
          return {
            from: vi.fn(() => ({
              where: vi.fn().mockResolvedValue([{ version: 7 }]),
            })),
          };
        }
        return {
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({ orderBy: vi.fn().mockResolvedValue([]) })),
            })),
          })),
        };
      }),
    };
    db.transaction.mockImplementation(async (callback: (database: typeof tx) => unknown) =>
      callback(tx),
    );
    const controller = new EnvelopesController(
      db as unknown as Database,
      createScope() as unknown as OrgScopeService,
    );

    const response = await controller.recompute(USER_ID, FACILITY_ID);

    expect(response.envelope.status).toBe('BLOCKED');
    expect(insertedEnvelope).toMatchObject({ version: 8, status: 'BLOCKED' });
    expect(tx.update).not.toHaveBeenCalled();
    expect(priorCurrent.status).toBe('CURRENT');
  });
});

describe('identifier validation', () => {
  it('returns a clean 400 for a malformed envelope facility id before touching persistence', async () => {
    const database = { select: vi.fn() };
    const scope = createScope();
    const moduleRef = await Test.createTestingModule({
      controllers: [EnvelopesController],
      providers: [
        { provide: DATABASE, useValue: database },
        { provide: OrgScopeService, useValue: scope },
      ],
    }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new ErrorFilter());
    app.getHttpAdapter().getInstance().addHook('preHandler', (request, _reply, done) => {
      const authenticated = request as typeof request & {
        gridflexUser?: { id: string; email: string };
      };
      authenticated.gridflexUser = { id: USER_ID, email: 'pilot-owner@test.local' };
      done();
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/facilities/not-a-uuid/envelopes/current',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
      expect(scope.requireFacility).not.toHaveBeenCalled();
      expect(database.select).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
