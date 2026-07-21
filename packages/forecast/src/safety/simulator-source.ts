/**
 * Simulated thermal and state-of-charge source.
 *
 * The facility has no BMS or BESS connector, so nothing produces
 * `thermal.max_inlet_c` or `battery.state_of_charge_pct` and every plan touching
 * cooling or storage blocks. This source fills that gap so the pipeline can be
 * exercised end to end — and marks every reading `simulated: true`, so it can
 * never clear a safety gate for a real drill.
 *
 * Deterministic for a given seed, matching the assurance engine's simulator
 * (spec §11): the same seed produces byte-identical output, so a replayed
 * scenario is reproducible.
 *
 * This is scaffolding for a real connector, not a substitute for one. Its value
 * is that it makes the missing-connector problem visible and testable rather
 * than leaving the risk path unreachable.
 */
import { formatUtcInstant, parseUtcInstant } from '../features/index.js';
import { STATE_OF_CHARGE_METRIC, THERMAL_METRIC, type SafetyReading } from './index.js';

export const SIMULATOR_SOURCE_VERSION = 'gridflex-safety-simulator-1.0.0';

/** mulberry32, as used by the assurance engine's simulator. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulateSafetyInput {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly intervalSeconds: number;
  readonly seed: number;
  /** Inlet temperature the facility idles around, in C. */
  readonly baselineInletC?: number;
  /** State of charge the facility idles around, as a percentage. */
  readonly baselineStateOfChargePct?: number;
  /** Windows during which cooling is reduced, raising inlet temperature. */
  readonly coolingReductionWindows?: readonly { start: string; end: string }[];
  /** Windows during which storage discharges, draining state of charge. */
  readonly dischargeWindows?: readonly { start: string; end: string }[];
}

const DEFAULT_BASELINE_INLET_C = 24;
const DEFAULT_BASELINE_SOC_PCT = 92;

/** Degrees the inlet rises per minute while cooling is reduced. */
const INLET_RISE_C_PER_MIN = 0.12;

/** Percentage points of charge lost per minute while discharging. */
const SOC_DRAIN_PCT_PER_MIN = 1.4;

export function simulateSafetyReadings(input: SimulateSafetyInput): readonly SafetyReading[] {
  const startMs = parseUtcInstant(input.windowStart);
  const endMs = parseUtcInstant(input.windowEnd);
  if (endMs <= startMs) throw new RangeError('Window end must be strictly after window start');
  if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds <= 0) {
    throw new RangeError('Interval seconds must be a positive integer');
  }

  const random = mulberry32(input.seed);
  const stepMs = input.intervalSeconds * 1000;
  const baselineInlet = input.baselineInletC ?? DEFAULT_BASELINE_INLET_C;
  const baselineSoc = input.baselineStateOfChargePct ?? DEFAULT_BASELINE_SOC_PCT;

  const cooling = (input.coolingReductionWindows ?? []).map((w) => ({
    startMs: parseUtcInstant(w.start),
    endMs: parseUtcInstant(w.end),
  }));
  const discharge = (input.dischargeWindows ?? []).map((w) => ({
    startMs: parseUtcInstant(w.start),
    endMs: parseUtcInstant(w.end),
  }));

  const readings: SafetyReading[] = [];

  for (let at = startMs; at < endMs; at += stepMs) {
    const measuredAt = formatUtcInstant(at);

    // Inlet temperature rises while cooling is reduced and recovers afterwards.
    const coolingWindow = cooling.find((w) => at >= w.startMs && at < w.endMs);
    const minutesIntoCooling = coolingWindow === undefined ? 0 : (at - coolingWindow.startMs) / 60_000;
    const inletC =
      baselineInlet + minutesIntoCooling * INLET_RISE_C_PER_MIN + (random() - 0.5) * 0.4;

    // State of charge drains while discharging, then holds.
    const dischargeWindow = discharge.find((w) => at >= w.startMs && at < w.endMs);
    const minutesIntoDischarge =
      dischargeWindow === undefined ? 0 : (at - dischargeWindow.startMs) / 60_000;
    const socPct = Math.max(
      0,
      baselineSoc - minutesIntoDischarge * SOC_DRAIN_PCT_PER_MIN + (random() - 0.5) * 0.6,
    );

    readings.push({
      metricKey: THERMAL_METRIC,
      measuredAt,
      value: Number(inletC.toFixed(3)),
      quality: 'GOOD',
      simulated: true,
    });
    readings.push({
      metricKey: STATE_OF_CHARGE_METRIC,
      measuredAt,
      value: Number(socPct.toFixed(3)),
      quality: 'GOOD',
      simulated: true,
    });
  }

  return readings;
}
