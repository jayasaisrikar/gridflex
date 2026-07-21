/**
 * Seeds 24 hours of deterministic simulator telemetry plus one completed drill,
 * its MRV report, and the sealed evidence bundle (`pnpm db:seed:sim`).
 *
 * Everything written here is produced by @gridflex/engine from a fixed seed, so
 * re-running reproduces byte-identical values. Nothing is hand-authored — the
 * UI must never display a number that did not come out of the engine.
 *
 * Idempotent: telemetry relies on the (facility, source_key, metric_key,
 * measured_at) unique constraint and skips conflicts; the drill is keyed by name.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  CANONICAL_DRILL,
  CANONICAL_FACILITY,
  computeBaseline,
  computeMrv,
  energyWh,
  kwNumberToMilliKw,
  milliKwToKwString,
  sealDocument,
  simulateBaselineDays,
  simulateDrill,
  MRV_METHODOLOGY_VERSION,
} from '@gridflex/engine';

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 20260721;
const FACILITY_SLUG = 'lone-star-compute';
const SOURCE_KEY = 'simulator-main-meter';
const DRILL_NAME = 'Canonical 500 kW · 30 min';

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const text = readFileSync(resolve(here, '../../../.env'), 'utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('DATABASE_URL=')) return line.slice('DATABASE_URL='.length).trim();
  }
  throw new Error('DATABASE_URL is required');
}

/** Deterministic 24h baseline load curve, ending now, at 1-minute intervals. */
function buildDayCurve(endMs: number, intervalSeconds: number, count: number) {
  const days = simulateBaselineDays({ seed: SEED, dayCount: 1, intervalCount: count });
  const samples = days[0]?.samples ?? [];
  return samples.map((sample, index) => ({
    measuredAt: new Date(endMs - (count - 1 - index) * intervalSeconds * 1000),
    milliKw: sample.power,
  }));
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 8_000 });
  await client.connect();

  try {
    const facility = await client.query<{ id: string; organization_id: string }>(
      `select id, organization_id from facilities where slug = $1`,
      [FACILITY_SLUG],
    );
    if (facility.rowCount === 0) {
      throw new Error(`Facility "${FACILITY_SLUG}" not found — run pnpm db:seed first`);
    }
    const facilityId = facility.rows[0]!.id;
    const organizationId = facility.rows[0]!.organization_id;

    // ---- Connector -------------------------------------------------------
    const connector = await client.query<{ id: string }>(
      `insert into connectors (facility_id, name, connector_type, status, config_summary, poll_interval_seconds)
       values ($1, 'Simulator main meter', 'SIMULATOR', 'ACTIVE', $2::jsonb, 60)
       on conflict do nothing
       returning id`,
      [facilityId, JSON.stringify({ seed: SEED, simulated: true })],
    );
    let connectorId = connector.rows[0]?.id;
    if (!connectorId) {
      const existing = await client.query<{ id: string }>(
        `select id from connectors where facility_id = $1 and connector_type = 'SIMULATOR' limit 1`,
        [facilityId],
      );
      connectorId = existing.rows[0]?.id;
    }

    // ---- 24h of background telemetry ------------------------------------
    const intervalSeconds = 60;
    const dayIntervals = (24 * 3600) / intervalSeconds; // 1440
    const nowMs = Date.now();
    const curve = buildDayCurve(nowMs, intervalSeconds, dayIntervals);

    // ---- The drill sits at the end of the window ------------------------
    const simulation = simulateDrill({ seed: SEED });
    const sustainCount = simulation.sustain.length;
    const drillStartMs = nowMs - sustainCount * intervalSeconds * 1000;

    // Replace the tail of the curve with the drill's actual load.
    const merged = curve.map((point, index) => {
      const drillIndex = index - (curve.length - sustainCount);
      if (drillIndex >= 0) {
        const interval = simulation.sustain[drillIndex];
        return {
          measuredAt: new Date(drillStartMs + drillIndex * intervalSeconds * 1000),
          milliKw: interval?.facilityPowerKw ?? point.milliKw,
        };
      }
      return point;
    });

    console.log(`Writing ${merged.length} telemetry readings…`);
    const CHUNK = 500;
    let inserted = 0;
    for (let offset = 0; offset < merged.length; offset += CHUNK) {
      const chunk = merged.slice(offset, offset + CHUNK);
      const values: unknown[] = [];
      const tuples = chunk.map((point, index) => {
        const base = index * 7;
        values.push(
          organizationId,
          facilityId,
          connectorId ?? null,
          SOURCE_KEY,
          'facility.active_power_kw',
          point.measuredAt.toISOString(),
          Number(milliKwToKwString(point.milliKw)),
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, 'kW', 'GOOD')`;
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
    console.log(`  inserted ${inserted} (duplicates skipped)`);

    await client.query(
      `update connectors set last_sync_at = now(), last_success_at = now() where id = $1`,
      [connectorId],
    );

    // ---- Compute MRV from the engine ------------------------------------
    const baseline = computeBaseline({
      eligibleDays: simulateBaselineDays({
        seed: SEED,
        dayCount: 5,
        intervalCount: sustainCount,
      }),
      precedingNonEventSamples: [],
      intervalCount: sustainCount,
    });

    const committedEnergyWh = energyWh(
      kwNumberToMilliKw(CANONICAL_DRILL.requestedReductionKw),
      CANONICAL_DRILL.sustainMinutes * 60,
    );

    const mrv = computeMrv({
      baseline,
      actual: simulation.sustain.map((interval) => ({
        measuredAt: interval.measuredAt,
        power: interval.facilityPowerKw,
      })),
      intervalSeconds: simulation.intervalSeconds,
      committedEnergyWh,
    });

    console.log(
      `MRV: ${Number(mrv.deliveredEnergyWh) / 1000} kWh · ${mrv.performanceBps} bps · ${mrv.averageDeliveredKw} kW avg`,
    );

    // ---- Owner + envelope ------------------------------------------------
    const owner = await client.query<{ id: string }>(
      `select u.id from app_users u
       join organization_members m on m.user_id = u.id
       where m.organization_id = $1 order by m.created_at limit 1`,
      [organizationId],
    );
    let ownerId = owner.rows[0]?.id;

    if (!ownerId) {
      // The demo facility ships in its own organization, but bootstrap-owner
      // creates the first user in a *different* org. Attach the existing owner
      // here so the seeded facility is actually reachable, rather than silently
      // seeding data nobody can see.
      const anyUser = await client.query<{ id: string; email: string }>(
        `select id, email from app_users order by created_at limit 1`,
      );
      if (anyUser.rowCount === 0) {
        throw new Error(
          'No user exists. Bootstrap an owner through POST /api/v1/auth/bootstrap-owner first.',
        );
      }
      ownerId = anyUser.rows[0]!.id;
      await client.query(
        `insert into organization_members (organization_id, user_id, role)
         values ($1, $2, 'OWNER')
         on conflict (organization_id, user_id) do nothing`,
        [organizationId, ownerId],
      );
      console.log(`  linked ${anyUser.rows[0]!.email} to the demo organization as OWNER`);
    }

    const envelope = await client.query<{ id: string }>(
      `select id from envelopes where facility_id = $1 and status = 'CURRENT' limit 1`,
      [facilityId],
    );
    const envelopeId = envelope.rows[0]?.id ?? null;

    // ---- Drill -----------------------------------------------------------
    const existingDrill = await client.query<{ id: string }>(
      `select id from drills where facility_id = $1 and name = $2 limit 1`,
      [facilityId, DRILL_NAME],
    );

    let drillId = existingDrill.rows[0]?.id;
    const drillEndMs = drillStartMs + sustainCount * intervalSeconds * 1000;

    if (!drillId) {
      const created = await client.query<{ id: string }>(
        `insert into drills
           (organization_id, facility_id, envelope_id, name, status,
            requested_reduction_kw, planned_start_at, planned_end_at,
            baseline_method, maximum_ramp_kw_per_min, minimum_safe_load_kw,
            simulation_mode, created_by, armed_by, armed_at, started_at, ended_at)
         values ($1,$2,$3,$4,'COMPLETED',$5,$6,$7,$8,$9,$10,true,$11,$11,$6,$6,$7)
         returning id`,
        [
          organizationId,
          facilityId,
          envelopeId,
          DRILL_NAME,
          CANONICAL_DRILL.requestedReductionKw.toFixed(3),
          new Date(drillStartMs).toISOString(),
          new Date(drillEndMs).toISOString(),
          baseline.method,
          CANONICAL_FACILITY.maximumRampKwPerMin.toFixed(3),
          CANONICAL_FACILITY.minimumSafeLoadKw.toFixed(3),
          ownerId,
        ],
      );
      drillId = created.rows[0]!.id;

      // Immutable event timeline — the proof chain the UI renders.
      const events: [string, number, string | null][] = [
        ['CREATED', 0, null],
        ['VALIDATED', 1, 'PLAN_WITHIN_LIMITS'],
        ['ARMED', 2, 'TWO_STEP_CONFIRMED'],
        ['STARTED', 3, null],
        ['COMPLETED', sustainCount * 60, null],
        ['MRV_GENERATED', sustainCount * 60 + 5, null],
      ];
      for (const [type, offsetSeconds, reason] of events) {
        await client.query(
          `insert into drill_events (drill_id, event_type, occurred_at, actor_user_id, reason_code, payload)
           values ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            drillId,
            type,
            new Date(drillStartMs + offsetSeconds * 1000).toISOString(),
            ownerId,
            reason,
            JSON.stringify({ simulated: true, seed: SEED }),
          ],
        );
      }
      console.log(`  drill created with ${events.length} immutable events`);
    } else {
      console.log('  drill already present — skipping');
    }

    // ---- MRV report ------------------------------------------------------
    const baselineSeries = baseline.series.map((value, index) => ({
      measured_at: new Date(drillStartMs + index * intervalSeconds * 1000).toISOString(),
      value: milliKwToKwString(value),
    }));
    const actualSeries = simulation.sustain.map((interval, index) => ({
      measured_at: new Date(drillStartMs + index * intervalSeconds * 1000).toISOString(),
      value: interval.facilityPowerKw === null ? null : milliKwToKwString(interval.facilityPowerKw),
    }));

    await client.query(
      `insert into mrv_reports
         (drill_id, methodology_version, interval_seconds, committed_energy_wh,
          delivered_energy_wh, average_delivered_kw, performance_bps,
          telemetry_completeness, maximum_gap_intervals, baseline_series,
          actual_series, quality_blocks)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb)
       on conflict (drill_id) do nothing`,
      [
        drillId,
        MRV_METHODOLOGY_VERSION,
        intervalSeconds,
        committedEnergyWh.toString(),
        mrv.deliveredEnergyWh.toString(),
        mrv.averageDeliveredKw,
        mrv.performanceBps,
        mrv.telemetryCompleteness.toFixed(4),
        mrv.maximumGapIntervals,
        JSON.stringify(baselineSeries),
        JSON.stringify(actualSeries),
        JSON.stringify(mrv.qualityBlocks),
      ],
    );

    // ---- Evidence bundle -------------------------------------------------
    const sealed = sealDocument({
      schema_version: 'gridflex-canonical-1',
      facility_slug: FACILITY_SLUG,
      drill_name: DRILL_NAME,
      simulated: true,
      seed: SEED,
      methodology_version: MRV_METHODOLOGY_VERSION,
      baseline_method: mrv.baselineMethod,
      committed_energy_wh: committedEnergyWh,
      delivered_energy_wh: mrv.deliveredEnergyWh,
      average_delivered_kw: mrv.averageDeliveredKw,
      performance_bps: mrv.performanceBps,
      telemetry_completeness: mrv.telemetryCompleteness.toFixed(4),
      maximum_gap_intervals: mrv.maximumGapIntervals,
    });

    const mrvRow = await client.query<{ id: string }>(
      `select id from mrv_reports where drill_id = $1`,
      [drillId],
    );

    await client.query(
      `insert into evidence_bundles
         (organization_id, facility_id, drill_id, mrv_report_id, schema_version,
          canonical_json, canonical_sha256)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7)
       on conflict (canonical_sha256) do nothing`,
      [
        organizationId,
        facilityId,
        drillId,
        mrvRow.rows[0]?.id ?? null,
        'gridflex-canonical-1',
        sealed.canonicalText,
        sealed.sha256,
      ],
    );

    console.log('');
    console.log('Simulation seed OK');
    console.log(`  telemetry     : ${merged.length} intervals over 24h`);
    console.log(`  drill         : ${DRILL_NAME} (COMPLETED, simulated)`);
    console.log(`  delivered     : ${Number(mrv.deliveredEnergyWh) / 1000} kWh`);
    console.log(`  performance   : ${mrv.performanceBps} bps`);
    console.log(`  evidence hash : ${sealed.sha256}`);
  } finally {
    await client.end();
  }
}

await main();
