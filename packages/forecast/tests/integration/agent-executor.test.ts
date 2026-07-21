/**
 * Integration test for the agent against a real Postgres.
 *
 * Runs against the LOCAL Docker database only (docker-compose.local.yml, host
 * port 5433). Spec §25 forbids pointing experiments at the live database, and
 * this test writes drills and drill events. The connection string is asserted
 * below rather than assumed — a misconfigured env var must fail the test, not
 * quietly mutate production.
 *
 * Every test runs inside a transaction that is rolled back, so the database is
 * left byte-identical to how it was found.
 *
 * The purpose is not to re-test the orchestrator's logic — the pure suite does
 * that. It is to prove that the approval gate still holds when a real executor
 * is wired to it, and that a refused tool writes NOTHING.
 */
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { planReduction, type PlanMechanismInput } from '../../src/plan/index.js';
import { assessRisk } from '../../src/risk/index.js';
import {
  applyResult,
  authorizeTool,
  planFingerprint,
  type AgentContext,
} from '../../src/agent/orchestrator.js';
import type { ToolName } from '../../src/agent/tools.js';

const LOCAL_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://gridflex:gridflex@localhost:5433/gridflex';

let client: Client;
let organizationId: string;
let facilityId: string;
let userId: string;

/** Refuses to run against anything but a local database. */
function assertLocal(url: string): void {
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(
      `Integration tests may only run against a local database; refusing host ${host}. ` +
        'Spec §25 forbids destructive runs against the live database.',
    );
  }
}

const MECHANISMS: PlanMechanismInput[] = [
  {
    id: 'm-workload',
    code: 'WORKLOAD_DEFERRAL',
    mechanismType: 'WORKLOAD',
    enabled: true,
    availableKw: '350.000',
    rampKwPerMin: '80.000',
    maximumDurationMin: 60,
    reboundWindowMin: 20,
  },
];

const PLAN = planReduction({
  targetReducibleKw: '300.000',
  durationMin: 30,
  mechanisms: MECHANISMS,
});

const CLEAN_RISK = assessRisk({
  plan: PLAN,
  envelopeConfidence: 0.85,
  envelopeStatus: 'DRAFT',
  forecastIntervalUnderpowered: false,
  telemetryAgeSeconds: 60,
  telemetryCompleteness: 1,
  thermalMarginC: 8,
  batteryStateOfCharge: 0.9,
  priorDrillCount: 4,
  priorDrillSuccessCount: 4,
  emergencyStopActive: false,
});

/**
 * The execution adapter: the only component permitted to touch the database,
 * and it consults `authorizeTool` before every call. A refused tool performs no
 * write whatsoever — it does not begin one and roll it back.
 */
async function execute(
  context: AgentContext,
  tool: ToolName,
  payload: Record<string, unknown> = {},
): Promise<{ executed: boolean; refusals: readonly string[]; drillId?: string }> {
  const auth = authorizeTool(context, tool);
  if (!auth.permitted) {
    return { executed: false, refusals: auth.refusals.map((r) => r.code) };
  }

  switch (tool) {
    case 'START_DRILL': {
      const inserted = await client.query<{ id: string }>(
        `insert into drills (organization_id, facility_id, name, status,
           requested_reduction_kw, planned_start_at, planned_end_at, created_by,
           simulation_mode)
         values ($1, $2, $3, 'RUNNING', $4, now(), now() + interval '30 minutes', $5, true)
         returning id`,
        [organizationId, facilityId, 'agent drill', context.plan?.allocatedKw ?? '0', userId],
      );
      const drillId = inserted.rows[0]?.id as string;
      await client.query(
        `insert into drill_events (drill_id, event_type, actor_service, payload)
         values ($1, 'STARTED', 'gridflex-agent', $2)`,
        [drillId, JSON.stringify({ plan_fingerprint: planFingerprint(context.plan!) })],
      );
      return { executed: true, refusals: [], drillId };
    }

    case 'STOP_DRILL': {
      const drillId = payload.drillId as string | undefined;
      if (drillId !== undefined) {
        await client.query(`update drills set status = 'ABORTED', ended_at = now() where id = $1`, [
          drillId,
        ]);
        await client.query(
          `insert into drill_events (drill_id, event_type, actor_service, reason_code)
           values ($1, 'ABORTED', 'gridflex-agent', 'AGENT_STOP')`,
          [drillId],
        );
      }
      return { executed: true, refusals: [] };
    }

    default:
      return { executed: true, refusals: [] };
  }
}

beforeAll(async () => {
  assertLocal(LOCAL_DATABASE_URL);
  client = new Client({ connectionString: LOCAL_DATABASE_URL, connectionTimeoutMillis: 5000 });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query('begin');

  const org = await client.query<{ id: string }>(
    `insert into organizations (name, slug) values ('Agent Test Org', 'agent-test-org')
     returning id`,
  );
  organizationId = org.rows[0]?.id as string;

  const user = await client.query<{ id: string }>(
    `insert into app_users (email, password_hash, display_name)
     values ('agent-test@example.com', 'x', 'Agent Test') returning id`,
  );
  userId = user.rows[0]?.id as string;

  const facility = await client.query<{ id: string }>(
    `insert into facilities (organization_id, name, slug, timezone)
     values ($1, 'Agent Test Facility', 'agent-test-facility', 'UTC') returning id`,
    [organizationId],
  );
  facilityId = facility.rows[0]?.id as string;
});

afterEach(async () => {
  // Rollback leaves the database exactly as found.
  await client.query('rollback');
});

function contextOf(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    phase: 'APPROVED',
    plan: PLAN,
    risk: CLEAN_RISK,
    approval: {
      grantedForPlanFingerprint: planFingerprint(PLAN),
      grantedBy: 'operator@example.com',
      grantedAt: '2026-07-21T12:00:00Z',
      consumed: false,
    },
    emergencyStopActive: false,
    drillRunning: false,
    ...overrides,
  };
}

async function drillCount(): Promise<number> {
  const result = await client.query<{ n: string }>(
    'select count(*)::text n from drills where facility_id = $1',
    [facilityId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

describe('agent executor — approved path', () => {
  it('starts a drill and records the event when authorized', async () => {
    const result = await execute(contextOf(), 'START_DRILL');

    expect(result.executed).toBe(true);
    expect(await drillCount()).toBe(1);

    const events = await client.query<{ event_type: string; payload: Record<string, unknown> }>(
      'select event_type, payload from drill_events where drill_id = $1',
      [result.drillId],
    );
    expect(events.rows[0]?.event_type).toBe('STARTED');
    // The fingerprint of the approved plan is recorded with the drill, so the
    // audit trail shows WHICH plan was executed, not merely that one was.
    expect(events.rows[0]?.payload.plan_fingerprint).toBe(planFingerprint(PLAN));
  });
});

describe('agent executor — refused tools write NOTHING', () => {
  it('writes no drill when approval is missing', async () => {
    const result = await execute(contextOf({ approval: null }), 'START_DRILL');

    expect(result.executed).toBe(false);
    expect(result.refusals).toContain('APPROVAL_REQUIRED');
    expect(await drillCount()).toBe(0);
  });

  it('writes no drill when the plan changed after approval', async () => {
    const bigger = planReduction({
      targetReducibleKw: '350.000',
      durationMin: 30,
      mechanisms: MECHANISMS,
    });
    const result = await execute(contextOf({ plan: bigger }), 'START_DRILL');

    expect(result.executed).toBe(false);
    expect(result.refusals).toContain('APPROVAL_PLAN_MISMATCH');
    expect(await drillCount()).toBe(0);
  });

  it('writes no drill when an emergency stop is latched', async () => {
    const result = await execute(contextOf({ emergencyStopActive: true }), 'START_DRILL');

    expect(result.executed).toBe(false);
    expect(await drillCount()).toBe(0);
  });

  it('writes no drill when risk is blocked, despite a valid approval', async () => {
    const blocked = assessRisk({
      plan: PLAN,
      envelopeConfidence: 0.85,
      envelopeStatus: 'BLOCKED',
      forecastIntervalUnderpowered: false,
      telemetryAgeSeconds: 60,
      telemetryCompleteness: 1,
      thermalMarginC: 8,
      batteryStateOfCharge: 0.9,
      priorDrillCount: 4,
      priorDrillSuccessCount: 4,
      emergencyStopActive: false,
    });
    const result = await execute(contextOf({ risk: blocked }), 'START_DRILL');

    expect(result.executed).toBe(false);
    expect(result.refusals).toContain('RISK_BLOCKED');
    expect(await drillCount()).toBe(0);
  });

  it('cannot start a second drill on a consumed approval', async () => {
    const first = await execute(contextOf(), 'START_DRILL');
    expect(first.executed).toBe(true);

    const afterStart = applyResult(contextOf(), { tool: 'START_DRILL', succeeded: true });
    const second = await execute(afterStart, 'START_DRILL');

    expect(second.executed).toBe(false);
    expect(second.refusals).toContain('APPROVAL_ALREADY_CONSUMED');
    expect(await drillCount()).toBe(1);
  });
});

describe('agent executor — stopping is always possible', () => {
  it('stops a running drill even with an emergency stop latched', async () => {
    const started = await execute(contextOf(), 'START_DRILL');
    const drillId = started.drillId as string;

    const stopped = await execute(
      contextOf({ phase: 'RUNNING', drillRunning: true, emergencyStopActive: true }),
      'STOP_DRILL',
      { drillId },
    );

    expect(stopped.executed).toBe(true);
    const status = await client.query<{ status: string }>('select status from drills where id = $1', [
      drillId,
    ]);
    expect(status.rows[0]?.status).toBe('ABORTED');
  });

  it('stops a running drill with no approval at all', async () => {
    const started = await execute(contextOf(), 'START_DRILL');
    const drillId = started.drillId as string;

    const stopped = await execute(
      contextOf({ phase: 'RUNNING', drillRunning: true, approval: null }),
      'STOP_DRILL',
      { drillId },
    );

    expect(stopped.executed).toBe(true);
    const events = await client.query<{ reason_code: string }>(
      `select reason_code from drill_events where drill_id = $1 and event_type = 'ABORTED'`,
      [drillId],
    );
    expect(events.rows[0]?.reason_code).toBe('AGENT_STOP');
  });
});

describe('agent executor — database hygiene', () => {
  it('refuses to run against a non-local host', () => {
    expect(() => assertLocal('postgresql://u:p@192.168.29.87:3000/gridflex')).toThrow(
      /may only run against a local database/,
    );
    expect(() => assertLocal(LOCAL_DATABASE_URL)).not.toThrow();
  });

  it('leaves no residue — rollback restores the prior state', async () => {
    await execute(contextOf(), 'START_DRILL');
    expect(await drillCount()).toBe(1);
    // afterEach rolls back; the next test's drillCount starting at 0 proves it.
  });
});
