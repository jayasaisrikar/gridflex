/**
 * Integration test for the safety connector against a real Postgres.
 *
 * LOCAL Docker only — this writes telemetry rows. Each test runs inside a
 * transaction that is rolled back.
 *
 * Proves the round trip: simulated thermal and state-of-charge readings are
 * persisted as canonical metrics, read back, resolved with their provenance
 * intact, and correctly refused as authorisation for a real drill.
 */
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  STATE_OF_CHARGE_METRIC,
  THERMAL_METRIC,
  resolveSafetySignal,
  satisfiesSafetyGate,
  stateOfCharge,
  thermalMarginC,
  type SafetyReading,
} from '../../src/safety/index.js';
import { simulateSafetyReadings } from '../../src/safety/simulator-source.js';

const LOCAL_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://gridflex:gridflex@localhost:5433/gridflex';

let client: Client;
let organizationId: string;
let facilityId: string;
let connectorId: string;

function assertLocal(url: string): void {
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`Integration tests may only run against a local database; refusing ${host}.`);
  }
}

const WINDOW_START = '2026-07-21T11:00:00Z';
const WINDOW_END = '2026-07-21T12:00:00Z';
const ASOF = '2026-07-21T11:59:00Z';

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
    `insert into organizations (name, slug) values ('Safety Test Org', 'safety-test-org') returning id`,
  );
  organizationId = org.rows[0]?.id as string;

  const facility = await client.query<{ id: string }>(
    `insert into facilities (organization_id, name, slug, timezone)
     values ($1, 'Safety Test Facility', 'safety-test-facility', 'UTC') returning id`,
    [organizationId],
  );
  facilityId = facility.rows[0]?.id as string;

  const connector = await client.query<{ id: string }>(
    `insert into connectors (facility_id, name, connector_type, status, poll_interval_seconds, config_summary)
     values ($1, 'Simulated BMS and BESS', 'SIMULATOR', 'ACTIVE', 60, $2) returning id`,
    [facilityId, JSON.stringify({ seed: 20260721, simulated: true, emits: [THERMAL_METRIC, STATE_OF_CHARGE_METRIC] })],
  );
  connectorId = connector.rows[0]?.id as string;
});

afterEach(async () => {
  await client.query('rollback');
});

/** Persists simulated readings as canonical telemetry rows. */
async function ingest(readings: readonly SafetyReading[]): Promise<number> {
  let inserted = 0;
  for (const reading of readings) {
    const unit = reading.metricKey === THERMAL_METRIC ? 'C' : '%';
    await client.query(
      `insert into telemetry_readings
         (organization_id, facility_id, connector_id, source_key, metric_key,
          measured_at, value_double, unit, quality, metadata)
       values ($1, $2, $3, 'sim-bms', $4, $5, $6, $7, 'GOOD', $8)`,
      [
        organizationId,
        facilityId,
        connectorId,
        reading.metricKey,
        reading.measuredAt,
        reading.value,
        unit,
        JSON.stringify({ simulated: true }),
      ],
    );
    inserted += 1;
  }
  return inserted;
}

/** Reads back, carrying provenance from the connector type. */
async function readSafety(): Promise<SafetyReading[]> {
  const rows = await client.query<{
    metric_key: string;
    measured_at: Date;
    value_double: number;
    quality: string;
    connector_type: string;
  }>(
    `select t.metric_key, t.measured_at, t.value_double, t.quality, c.connector_type
       from telemetry_readings t
       join connectors c on c.id = t.connector_id
      where t.facility_id = $1 and t.metric_key = any($2)`,
    [facilityId, [THERMAL_METRIC, STATE_OF_CHARGE_METRIC]],
  );

  return rows.rows.map((row) => ({
    metricKey: row.metric_key,
    measuredAt: row.measured_at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    value: row.value_double,
    quality: row.quality as SafetyReading['quality'],
    // Provenance comes from the connector, not from the reading claiming it.
    simulated: row.connector_type === 'SIMULATOR',
  }));
}

describe('safety connector — round trip', () => {
  it('persists both canonical metrics with correct units', async () => {
    const readings = simulateSafetyReadings({
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      intervalSeconds: 300,
      seed: 20260721,
    });
    const count = await ingest(readings);
    expect(count).toBe(readings.length);

    const units = await client.query<{ metric_key: string; unit: string }>(
      'select distinct metric_key, unit from telemetry_readings where facility_id = $1',
      [facilityId],
    );
    const byMetric = Object.fromEntries(units.rows.map((r) => [r.metric_key, r.unit]));
    expect(byMetric[THERMAL_METRIC]).toBe('C');
    expect(byMetric[STATE_OF_CHARGE_METRIC]).toBe('%');
  });

  it('carries simulated provenance back from the connector type', async () => {
    await ingest(
      simulateSafetyReadings({
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        intervalSeconds: 300,
        seed: 20260721,
      }),
    );

    const readings = await readSafety();
    expect(readings.length).toBeGreaterThan(0);
    // Provenance is derived from the connector, so a reading cannot lie about it.
    expect(readings.every((r) => r.simulated)).toBe(true);
  });

  it('resolves to SIMULATED and REFUSES to authorise a real drill', async () => {
    await ingest(
      simulateSafetyReadings({
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        intervalSeconds: 300,
        seed: 20260721,
      }),
    );
    const readings = await readSafety();

    const thermal = resolveSafetySignal({ readings, metricKey: THERMAL_METRIC, asOf: ASOF });
    const soc = resolveSafetySignal({ readings, metricKey: STATE_OF_CHARGE_METRIC, asOf: ASOF });

    expect(thermal.status).toBe('SIMULATED');
    expect(soc.status).toBe('SIMULATED');

    // The whole point: real telemetry now EXISTS, but it is simulated, so it
    // still cannot authorise a physical reduction.
    expect(satisfiesSafetyGate(thermal, false)).toBe(false);
    expect(satisfiesSafetyGate(soc, false)).toBe(false);

    const context = { thermal, stateOfCharge: soc, simulationDrill: false };
    expect(thermalMarginC(context, 32)).toBeNull();
    expect(stateOfCharge(context)).toBeNull();
  });

  it('authorises a SIMULATION drill on the same data', async () => {
    await ingest(
      simulateSafetyReadings({
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        intervalSeconds: 300,
        seed: 20260721,
      }),
    );
    const readings = await readSafety();
    const context = {
      thermal: resolveSafetySignal({ readings, metricKey: THERMAL_METRIC, asOf: ASOF }),
      stateOfCharge: resolveSafetySignal({ readings, metricKey: STATE_OF_CHARGE_METRIC, asOf: ASOF }),
      simulationDrill: true,
    };

    expect(thermalMarginC(context, 32)).not.toBeNull();
    expect(stateOfCharge(context)).not.toBeNull();
  });

  it('a non-simulator connector yields MEASURED and authorises a real drill', async () => {
    // Proves the gate opens for genuine hardware — the refusal above is about
    // provenance, not a permanent block.
    const bms = await client.query<{ id: string }>(
      `insert into connectors (facility_id, name, connector_type, status, poll_interval_seconds)
       values ($1, 'Building management system', 'BMS_API', 'ACTIVE', 60) returning id`,
      [facilityId],
    );
    await client.query(
      `insert into telemetry_readings
         (organization_id, facility_id, connector_id, source_key, metric_key,
          measured_at, value_double, unit, quality)
       values ($1, $2, $3, 'bms', $4, $5, 24.5, 'C', 'GOOD')`,
      [organizationId, facilityId, bms.rows[0]?.id, THERMAL_METRIC, '2026-07-21T11:58:00Z'],
    );

    const readings = await readSafety();
    const thermal = resolveSafetySignal({ readings, metricKey: THERMAL_METRIC, asOf: ASOF });

    expect(thermal.status).toBe('MEASURED');
    expect(satisfiesSafetyGate(thermal, false)).toBe(true);
    expect(
      thermalMarginC({ thermal, stateOfCharge: thermal, simulationDrill: false }, 32),
    ).toBe(7.5);
  });

  it('rejects a unit that does not match the canonical metric', async () => {
    // Spec §10.1: a unit mismatch means sender and engine disagree about what
    // the number means. The contract layer rejects rather than coercing.
    const { CANONICAL_METRICS } = await import('@gridflex/contracts');
    expect(CANONICAL_METRICS[THERMAL_METRIC]).toBe('C');
    expect(CANONICAL_METRICS[STATE_OF_CHARGE_METRIC]).toBe('%');
  });
});
