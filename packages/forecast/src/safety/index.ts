/**
 * Safety telemetry: thermal margin and battery state of charge.
 *
 * These two signals gate any plan that raises cooling setpoints or discharges
 * storage. Until now the risk engine received them as bare numbers, which left
 * the most important question unasked: where did this number come from?
 *
 * A simulated thermal reading is not a thermal reading. It is a plausible number
 * produced by a model, and treating it as evidence would convert the risk
 * engine's honest `THERMAL_MARGIN_UNKNOWN` block into a pass — authorising a
 * real reduction against fabricated safety data. That is strictly worse than
 * refusing, because the refusal is visible and the false pass is not.
 *
 * So a signal carries its provenance, and `resolveSafetySignal` decides what
 * that provenance is worth for the drill actually being run:
 *
 *   MEASURED  — satisfies the gate.
 *   SIMULATED — satisfies it ONLY for a simulation drill.
 *   STALE     — never satisfies it; an old reading does not describe now.
 *   ABSENT    — never satisfies it.
 */
import { parseUtcInstant, type TelemetryQuality } from '../features/index.js';

export const SAFETY_READER_VERSION = 'gridflex-safety-1.0.0';

/** Canonical metric keys this module consumes, matching `CANONICAL_METRICS`. */
export const THERMAL_METRIC = 'thermal.max_inlet_c';
export const STATE_OF_CHARGE_METRIC = 'battery.state_of_charge_pct';

/**
 * Age beyond which a safety reading no longer describes the facility now.
 * Deliberately tighter than the 900s general telemetry limit: a thermal margin
 * is the thing standing between a plan and equipment damage.
 */
export const MAXIMUM_SAFETY_AGE_SECONDS = 300;

export type SafetyStatus = 'MEASURED' | 'SIMULATED' | 'STALE' | 'ABSENT';

export interface SafetyReading {
  readonly metricKey: string;
  readonly measuredAt: string;
  readonly value: number;
  readonly quality: TelemetryQuality;
  /** True when the producing connector is a simulator. */
  readonly simulated: boolean;
}

export interface SafetySignal {
  readonly metricKey: string;
  readonly status: SafetyStatus;
  /** Null unless a usable reading was found. Never inferred. */
  readonly value: number | null;
  readonly measuredAt: string | null;
  readonly ageSeconds: number | null;
  readonly detail: string;
}

export interface ResolveSafetyInput {
  readonly readings: readonly SafetyReading[];
  readonly metricKey: string;
  /** Instant the decision is being made at. */
  readonly asOf: string;
  readonly maximumAgeSeconds?: number;
}

/** Reduces a metric's readings to a single signal with explicit provenance. */
export function resolveSafetySignal(input: ResolveSafetyInput): SafetySignal {
  const { metricKey } = input;
  const asOfMs = parseUtcInstant(input.asOf);
  const maximumAge = input.maximumAgeSeconds ?? MAXIMUM_SAFETY_AGE_SECONDS;

  const candidates = input.readings
    .filter((reading) => reading.metricKey === metricKey && reading.quality === 'GOOD')
    .sort((a, b) => parseUtcInstant(b.measuredAt) - parseUtcInstant(a.measuredAt));

  const newest = candidates[0];
  if (newest === undefined) {
    return {
      metricKey,
      status: 'ABSENT',
      value: null,
      measuredAt: null,
      ageSeconds: null,
      detail: `No GOOD reading of ${metricKey} is available.`,
    };
  }

  const ageSeconds = Math.max(0, Math.round((asOfMs - parseUtcInstant(newest.measuredAt)) / 1000));

  if (ageSeconds > maximumAge) {
    return {
      metricKey,
      status: 'STALE',
      // The value is reported for diagnostics but the status is what gates.
      value: newest.value,
      measuredAt: newest.measuredAt,
      ageSeconds,
      detail: `Newest ${metricKey} is ${ageSeconds}s old, beyond the ${maximumAge}s safety limit.`,
    };
  }

  return {
    metricKey,
    status: newest.simulated ? 'SIMULATED' : 'MEASURED',
    value: newest.value,
    measuredAt: newest.measuredAt,
    ageSeconds,
    detail: newest.simulated
      ? `${metricKey} is ${newest.value}, produced by a SIMULATOR connector.`
      : `${metricKey} is ${newest.value}, measured ${ageSeconds}s ago.`,
  };
}

/**
 * Whether a signal may satisfy a safety gate for the drill being run.
 *
 * The `simulationDrill` argument is the whole point. A simulation may proceed on
 * simulated inputs because nothing physical happens; a real drill may not,
 * because something does.
 */
export function satisfiesSafetyGate(signal: SafetySignal, simulationDrill: boolean): boolean {
  if (signal.status === 'MEASURED') return true;
  if (signal.status === 'SIMULATED') return simulationDrill;
  return false;
}

export interface SafetyContext {
  readonly thermal: SafetySignal;
  readonly stateOfCharge: SafetySignal;
  readonly simulationDrill: boolean;
}

/**
 * Thermal margin in degrees C, or null when no usable measurement backs it.
 *
 * Returns null rather than a number whenever the gate is unsatisfied, so a
 * caller cannot accidentally use a simulated or stale value as though it were
 * measured — the risk engine already treats null as blocking.
 */
export function thermalMarginC(
  context: SafetyContext,
  thermalLimitC: number,
): number | null {
  if (!satisfiesSafetyGate(context.thermal, context.simulationDrill)) return null;
  if (context.thermal.value === null) return null;
  return Number((thermalLimitC - context.thermal.value).toFixed(3));
}

/** State of charge as a fraction in [0, 1], or null when unbacked. */
export function stateOfCharge(context: SafetyContext): number | null {
  if (!satisfiesSafetyGate(context.stateOfCharge, context.simulationDrill)) return null;
  if (context.stateOfCharge.value === null) return null;
  return Number((context.stateOfCharge.value / 100).toFixed(4));
}

/** Human-readable provenance summary, for the audit trail and explanations. */
export function describeSafetyProvenance(context: SafetyContext): readonly string[] {
  const lines: string[] = [];
  for (const signal of [context.thermal, context.stateOfCharge]) {
    const usable = satisfiesSafetyGate(signal, context.simulationDrill);
    lines.push(`${signal.metricKey}: ${signal.status}${usable ? '' : ' (does not satisfy gate)'} — ${signal.detail}`);
  }
  if (context.simulationDrill) {
    lines.push('Simulation drill: simulated safety telemetry is accepted because no physical action occurs.');
  }
  return lines;
}
