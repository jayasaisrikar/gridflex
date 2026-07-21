/**
 * READ-ONLY validation of the forecaster against real facility telemetry.
 *
 * Issues SELECTs only. Writes nothing, creates nothing, and must remain safe to
 * run against the live database (spec §25 forbids pointing experiments at it —
 * reading is the boundary of what this script does).
 *
 * Purpose: the seasonal baseline was developed entirely against fixtures. This
 * is the first contact with an actual load curve, and its job is to report what
 * happens honestly, including refusals.
 */
import { Client } from 'pg';
import {
  buildFeatureFrame,
  formatUtcInstant,
  parseUtcInstant,
  type RawReading,
} from '../src/features/index.js';
import { SeasonalBaselineForecaster } from '../src/forecast/seasonal-baseline.js';
import { clampToEnvelope } from '../src/forecast/clamp.js';
import { runBacktest, type BacktestCase } from '../src/backtest/index.js';
import type { HorizonMinutes } from '../src/forecast/types.js';
import { computeEnvelope } from '@gridflex/engine';

const INTERVAL_SECONDS = 300;
const METRIC = 'facility.active_power_kw';

function align(epochMillis: number, up: boolean): number {
  const step = INTERVAL_SECONDS * 1000;
  return (up ? Math.ceil(epochMillis / step) : Math.floor(epochMillis / step)) * step;
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const facility = (
    await client.query<{ id: string; name: string }>('select id, name from facilities limit 1')
  ).rows[0];
  if (facility === undefined) throw new Error('No facility found');

  const constraints = (
    await client.query<{
      minimum_safe_load_kw: string;
      maximum_curtailment_kw: string;
      maximum_ramp_kw_per_min: string;
      maximum_duration_min: number;
    }>(
      'select minimum_safe_load_kw, maximum_curtailment_kw, maximum_ramp_kw_per_min, maximum_duration_min from facility_constraints where facility_id = $1 limit 1',
      [facility.id],
    )
  ).rows[0];
  if (constraints === undefined) throw new Error('No constraints found');

  const mechanisms = (
    await client.query<{
      id: string;
      code: string;
      name: string;
      enabled: boolean;
      declared_reducible_kw: string | null;
      ramp_rate_kw_per_min: string | null;
      maximum_duration_min: number | null;
      rebound_window_min: number | null;
    }>(
      'select id, code, name, enabled, declared_reducible_kw, ramp_rate_kw_per_min, maximum_duration_min, rebound_window_min from flexibility_mechanisms where facility_id = $1',
      [facility.id],
    )
  ).rows;

  const rows = (
    await client.query<{ measured_at: Date; value_double: number; quality: string }>(
      'select measured_at, value_double, quality from telemetry_readings where facility_id = $1 and metric_key = $2 order by measured_at',
      [facility.id, METRIC],
    )
  ).rows;

  await client.end();

  console.log(`Facility: ${facility.name}`);
  console.log(`Readings: ${rows.length} of ${METRIC}`);

  const readings: RawReading[] = rows.map((row) => ({
    measuredAt: formatUtcInstant(row.measured_at.getTime()),
    valueKw: row.value_double,
    quality: row.quality as RawReading['quality'],
  }));

  const first = readings[0];
  const last = readings[readings.length - 1];
  if (first === undefined || last === undefined) throw new Error('No readings');

  const windowStart = formatUtcInstant(align(parseUtcInstant(first.measuredAt), true));
  const windowEnd = formatUtcInstant(align(parseUtcInstant(last.measuredAt), false));

  const frame = buildFeatureFrame({ readings, windowStart, windowEnd, intervalSeconds: INTERVAL_SECONDS });

  const loads = frame.intervals.filter((i) => i.powerMkw !== null).map((i) => Number(i.powerMkw) / 1000);
  console.log(`\nFrame ${windowStart} .. ${windowEnd}`);
  console.log(`  intervals     ${frame.intervals.length}`);
  console.log(`  completeness  ${(frame.completeness * 100).toFixed(1)}%`);
  console.log(`  quality blocks ${frame.qualityBlocks.length}`);
  console.log(
    `  load kW       min ${Math.min(...loads).toFixed(1)}  max ${Math.max(...loads).toFixed(1)}`,
  );

  const minimumSafeLoadKw = Number(constraints.minimum_safe_load_kw);
  const forecaster = new SeasonalBaselineForecaster();

  const envelope = computeEnvelope({
    mechanisms: mechanisms.map((m) => ({
      id: m.id,
      code: m.code,
      name: m.name,
      enabled: m.enabled,
      declaredReducibleKw: m.declared_reducible_kw === null ? null : Number(m.declared_reducible_kw),
      observedReducibleKw: null,
      constraintCapKw: null,
      rampKwPerMin: m.ramp_rate_kw_per_min === null ? null : Number(m.ramp_rate_kw_per_min),
      maximumDurationMin: m.maximum_duration_min,
      reboundWindowMin: m.rebound_window_min,
      testedReducibleKw: null,
      testCount: 0,
    })),
    p50NormalLoadKw: loads.sort((a, b) => a - b)[Math.floor(loads.length / 2)] ?? 0,
    minimumSafeLoadKw,
    maximumCurtailmentKw: Number(constraints.maximum_curtailment_kw),
    maximumRampKwPerMin: Number(constraints.maximum_ramp_kw_per_min),
    maximumDurationMin: constraints.maximum_duration_min,
    telemetryCompleteness: frame.completeness,
    modelingWindowDays: 1,
    constraintsVersion: 1,
    constraintsAgeDays: 1,
    hasExternalReview: false,
  });

  console.log(`\nEnvelope (real engine, real mechanisms)`);
  console.log(`  status        ${envelope.status}`);
  console.log(`  reducible kW  ${envelope.totalReducibleKw}`);
  console.log(`  confidence    ${envelope.confidenceScore}`);
  console.log(`  binding       ${envelope.bindingConstraint}`);

  // Forecast at several points across the last covered day.
  console.log(`\nForecasts (min safe load ${minimumSafeLoadKw} kW)`);
  const anchorMs = parseUtcInstant(windowEnd) - 6 * 3600 * 1000;
  for (const hourOffset of [0, 1, 2, 3]) {
    for (const horizon of [15, 30, 60] as HorizonMinutes[]) {
      const forecastAt = formatUtcInstant(anchorMs + hourOffset * 3600 * 1000);
      const result = forecaster.forecast({ frame, forecastAt, horizonMinutes: horizon, minimumSafeLoadKw });
      const claim = clampToEnvelope(result, envelope);
      const detail =
        result.status === 'OK'
          ? `fc ${(Number(result.reducibleMkw) / 1000).toFixed(1)} kW ` +
            `[${(Number(result.reducibleLowerMkw) / 1000).toFixed(1)}..${(Number(result.reducibleUpperMkw) / 1000).toFixed(1)}] ` +
            `conf ${result.modelConfidence.toFixed(3)} n=${result.samplesUsed}`
          : `REFUSED ${result.refusals[0]?.code}`;
      console.log(
        `  ${forecastAt} +${String(horizon).padStart(2)}m  ${detail.padEnd(62)} ` +
          `=> claim ${claim.claimedReducibleKw} kW conf ${claim.claimedConfidence} (${claim.bindingSide})`,
      );
    }
  }

  // Backtest: hold out the final 3 hours, forecast into it, score against truth.
  console.log(`\nBacktest (holdout: final 3h)`);
  const holdoutStartMs = parseUtcInstant(windowEnd) - 3 * 3600 * 1000;
  const trainFrame = buildFeatureFrame({
    readings,
    windowStart,
    windowEnd: formatUtcInstant(holdoutStartMs),
    intervalSeconds: INTERVAL_SECONDS,
  });

  const actualByStart = new Map<string, bigint>();
  for (const interval of frame.intervals) {
    if (interval.powerMkw === null) continue;
    const headroom = interval.powerMkw - BigInt(Math.round(minimumSafeLoadKw * 1000));
    actualByStart.set(interval.intervalStart, headroom > 0n ? headroom : 0n);
  }

  const cases: BacktestCase[] = [];
  for (let ms = holdoutStartMs; ms < parseUtcInstant(windowEnd); ms += 30 * 60 * 1000) {
    const targetMs = ms + 30 * 60 * 1000;
    const actual = actualByStart.get(formatUtcInstant(targetMs));
    if (actual === undefined) continue;
    cases.push({
      frame: trainFrame,
      forecastAt: formatUtcInstant(ms),
      horizonMinutes: 30,
      minimumSafeLoadKw,
      actualReducibleMkw: actual,
    });
  }

  const score = runBacktest(forecaster, cases);
  console.log(`  model         ${score.modelVersion}`);
  console.log(`  cases         ${score.caseCount} (scored ${score.scoredCount}, refused ${score.refusedCount})`);
  console.log(`  MAE           ${score.meanAbsoluteErrorKw} kW`);
  console.log(`  bias          ${score.meanBiasKw} kW  (positive = over-promises headroom)`);
  console.log(`  coverage      ${score.intervalCoverage} vs nominal ${score.nominalCoverage}`);
  console.log(`  under-covers  ${score.intervalUnderCovers}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
