/**
 * Continuous telemetry poller (`pnpm telemetry:poll`).
 *
 * The gap this fills: `seed-simulation.ts` writes a fixed historical window and
 * then stops. Nothing kept telemetry current, so the newest reading aged past
 * the risk engine's 900s staleness limit within fifteen minutes and every
 * downstream surface reported TELEMETRY_STALE. That is not a bug in the risk
 * engine — it was correctly reporting that nobody was feeding it.
 *
 * This process tops the facility up to now on the connector's poll interval,
 * generating power from the same seeded engine simulator the seed script uses,
 * and safety telemetry (thermal, state of charge) from the forecast package's
 * simulator source.
 *
 * Two properties matter:
 *
 *   - Idempotent. Inserts rely on the (facility, source_key, metric_key,
 *     measured_at) unique constraint and skip conflicts, so a restart or an
 *     overlapping run cannot double-count an interval.
 *   - Single-writer. A Postgres advisory lock means a second instance exits
 *     rather than interleaving writes with the first.
 *
 * Everything written is marked simulated, and is emitted by SIMULATOR
 * connectors, so the safety-provenance gate still refuses to let it authorise a
 * real drill.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { milliKwToKwString, simulateBaselineDays } from '@gridflex/engine';
import { simulateSafetyReadings } from '@gridflex/forecast';

const here = dirname(fileURLToPath(import.meta.url));

const SEED = 20260721;
const FACILITY_SLUG = 'dubai-compute-campus';
const POWER_SOURCE_KEY = 'simulator-main-meter';
const SAFETY_SOURCE_KEY = 'simulator-bms-bess';
const INTERVAL_SECONDS = 60;

/** Advisory lock key; any other holder means another poller is running. */
const ADVISORY_LOCK_KEY = 4_120_260_721;

/** Never backfill further than this in one pass. */
const MAX_BACKFILL_HOURS = 48;

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const text = readFileSync(resolve(here, '../../../.env'), 'utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('DATABASE_URL=')) return line.slice('DATABASE_URL='.length).trim();
  }
  throw new Error('DATABASE_URL is not set and could not be read from .env');
}

function alignDown(epochMillis: number, seconds: number): number {
  const step = seconds * 1000;
  return Math.floor(epochMillis / step) * step;
}

interface Target {
  organizationId: string;
  facilityId: string;
  powerConnectorId: string;
  safetyConnectorId: string;
}

async function resolveTarget(client: pg.Client): Promise<Target> {
  const facility = await client.query<{ id: string; organization_id: string }>(
    'select id, organization_id from facilities where slug = $1',
    [FACILITY_SLUG],
  );
  const row = facility.rows[0];
  if (row === undefined) throw new Error(`No facility with slug ${FACILITY_SLUG}`);

  // Reuse the existing simulator connector for power so history stays attached
  // to one source rather than fragmenting across restarts.
  const power = await client.query<{ id: string }>(
    `select id from connectors
      where facility_id = $1 and connector_type = 'SIMULATOR'
      order by created_at limit 1`,
    [row.id],
  );
  let powerConnectorId = power.rows[0]?.id;
  if (powerConnectorId === undefined) {
    const created = await client.query<{ id: string }>(
      `insert into connectors (facility_id, name, connector_type, status, poll_interval_seconds, config_summary)
       values ($1, 'Simulator main meter', 'SIMULATOR', 'ACTIVE', $2, $3) returning id`,
      [row.id, INTERVAL_SECONDS, JSON.stringify({ seed: SEED, simulated: true })],
    );
    powerConnectorId = created.rows[0]?.id as string;
  }

  const safety = await client.query<{ id: string }>(
    `select id from connectors where facility_id = $1 and name = 'Simulated BMS and BESS' limit 1`,
    [row.id],
  );
  let safetyConnectorId = safety.rows[0]?.id;
  if (safetyConnectorId === undefined) {
    const created = await client.query<{ id: string }>(
      `insert into connectors (facility_id, name, connector_type, status, poll_interval_seconds, config_summary)
       values ($1, 'Simulated BMS and BESS', 'SIMULATOR', 'ACTIVE', $2, $3) returning id`,
      [
        row.id,
        INTERVAL_SECONDS,
        JSON.stringify({
          seed: SEED,
          simulated: true,
          emits: ['thermal.max_inlet_c', 'battery.state_of_charge_pct'],
        }),
      ],
    );
    safetyConnectorId = created.rows[0]?.id as string;
  }

  return {
    organizationId: row.organization_id,
    facilityId: row.id,
    powerConnectorId,
    safetyConnectorId,
  };
}

async function topUp(client: pg.Client, target: Target): Promise<number> {
  const newest = await client.query<{ latest: Date | null }>(
    'select max(measured_at) as latest from telemetry_readings where facility_id = $1 and metric_key = $2',
    [target.facilityId, 'facility.active_power_kw'],
  );

  const nowAligned = alignDown(Date.now(), INTERVAL_SECONDS);
  const earliest = nowAligned - MAX_BACKFILL_HOURS * 3600 * 1000;
  const latest = newest.rows[0]?.latest;
  const fromMs = Math.max(
    earliest,
    latest === null || latest === undefined
      ? nowAligned - 3600 * 1000
      : alignDown(latest.getTime(), INTERVAL_SECONDS) + INTERVAL_SECONDS * 1000,
  );

  if (fromMs > nowAligned) return 0;

  const count = Math.floor((nowAligned - fromMs) / (INTERVAL_SECONDS * 1000)) + 1;

  // Power, from the same seeded generator the seed script uses, at the Dubai
  // demo facility's 10 MW normal load (gridflex_seed.sql).
  const days = simulateBaselineDays({
    seed: SEED,
    dayCount: 1,
    intervalCount: count,
    normalLoadKw: 10_000,
  });
  const samples = days[0]?.samples ?? [];

  let inserted = 0;
  const CHUNK = 200;

  // Placeholders are numbered PER CHUNK. Numbering them against a global
  // offset while slicing values per chunk emits $1401 for a statement carrying
  // 1400 values, which Postgres reports only as "could not determine data type
  // of parameter $1" — and only once a backfill exceeds one chunk.
  for (let i = 0; i < samples.length; i += CHUNK) {
    const slice = samples.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples: string[] = [];

    slice.forEach((sample, offset) => {
      const measuredAt = new Date(fromMs + (i + offset) * INTERVAL_SECONDS * 1000);
      const base = values.length;
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, 'kW', 'GOOD')`,
      );
      values.push(
        target.organizationId,
        target.facilityId,
        target.powerConnectorId,
        POWER_SOURCE_KEY,
        'facility.active_power_kw',
        measuredAt,
        Number(milliKwToKwString(sample.power)),
      );
    });

    const result = await client.query(
      `insert into telemetry_readings
         (organization_id, facility_id, connector_id, source_key, metric_key,
          measured_at, value_double, unit, quality)
       values ${tuples.join(', ')}
       on conflict (facility_id, source_key, metric_key, measured_at) do nothing`,
      values,
    );
    inserted += result.rowCount ?? 0;
  }

  // Safety telemetry over the same window.
  const safety = simulateSafetyReadings({
    windowStart: new Date(fromMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    windowEnd: new Date(nowAligned + INTERVAL_SECONDS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    intervalSeconds: INTERVAL_SECONDS,
    seed: SEED,
  });

  for (let i = 0; i < safety.length; i += CHUNK) {
    const slice = safety.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const reading of slice) {
      const base = values.length;
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, 'GOOD')`,
      );
      values.push(
        target.organizationId,
        target.facilityId,
        target.safetyConnectorId,
        SAFETY_SOURCE_KEY,
        reading.metricKey,
        new Date(reading.measuredAt),
        reading.value,
        reading.metricKey === 'thermal.max_inlet_c' ? 'C' : '%',
      );
    }
    const result = await client.query(
      `insert into telemetry_readings
         (organization_id, facility_id, connector_id, source_key, metric_key,
          measured_at, value_double, unit, quality)
       values ${tuples.join(', ')}
       on conflict (facility_id, source_key, metric_key, measured_at) do nothing`,
      values,
    );
    inserted += result.rowCount ?? 0;
  }

  await client.query(
    'update connectors set last_sync_at = now(), last_success_at = now() where id = any($1::uuid[])',
    [[target.powerConnectorId, target.safetyConnectorId]],
  );

  return inserted;
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 8_000 });
  await client.connect();

  const lock = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [
    ADVISORY_LOCK_KEY,
  ]);
  if (lock.rows[0]?.locked !== true) {
    console.log('Another poller holds the advisory lock; exiting rather than interleaving writes.');
    await client.end();
    return;
  }

  const target = await resolveTarget(client);
  console.log(`Polling facility ${target.facilityId} every ${INTERVAL_SECONDS}s. Ctrl-C to stop.`);

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  do {
    try {
      const inserted = await topUp(client, target);
      const stale = await client.query<{ seconds: string }>(
        `select round(extract(epoch from (now() - max(measured_at))))::text as seconds
           from telemetry_readings where facility_id = $1`,
        [target.facilityId],
      );
      console.log(
        `${new Date().toISOString()} inserted ${inserted}, newest is ${stale.rows[0]?.seconds ?? '?'}s old`,
      );
    } catch (error: unknown) {
      // A failed pass must not kill the poller; the next one retries.
      console.error('poll failed:', error instanceof Error ? error.message : error);
    }
    if (once || stopping) break;
    await new Promise((r) => setTimeout(r, INTERVAL_SECONDS * 1000));
  } while (!stopping);

  await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  await client.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
