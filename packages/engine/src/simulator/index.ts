/**
 * Deterministic digital twin (spec §11).
 *
 * A given seed MUST generate identical telemetry and MRV output on any machine.
 * That rules out Math.random and any floating-point accumulation, so this uses an
 * explicit integer PRNG and emits exact milli-kilowatt values.
 *
 * Everything produced here is SIMULATED and must be labelled as such in the UI
 * and on any Passport derived from it.
 */
import { type MilliKw, kwNumberToMilliKw } from '../units.js';

export const SIMULATOR_VERSION = 'gridflex-simulator-1.0.0';

/** Canonical demo facility (spec §11), matching gridflex_seed.sql. */
export const CANONICAL_FACILITY = {
  normalLoadKw: 1600,
  minimumSafeLoadKw: 900,
  maximumCurtailmentKw: 600,
  maximumRampKwPerMin: 100,
  coolingReserveKw: 150,
} as const;

export const CANONICAL_DRILL = {
  requestedReductionKw: 500,
  sustainMinutes: 30,
  intervalSeconds: 60,
} as const;

/**
 * mulberry32 — small, fast, fully specified integer PRNG. Chosen over any
 * library so the sequence is auditable and stable across Node versions.
 * Returns integers in [0, 2^32).
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Uniform integer in [min, max] inclusive, from a raw PRNG draw. */
function uniformInt(draw: number, min: number, max: number): number {
  const span = max - min + 1;
  return min + (draw % span);
}

export type FaultKind =
  | 'STALE_TELEMETRY'
  | 'MISSING_INTERVALS'
  | 'THERMAL_VIOLATION'
  | 'RAMP_VIOLATION'
  | 'ACTUATOR_NACK'
  | 'EMERGENCY_STOP';

export interface SimulationOptions {
  readonly seed: number;
  readonly normalLoadKw?: number;
  readonly requestedReductionKw?: number;
  readonly sustainMinutes?: number;
  readonly intervalSeconds?: number;
  /**
   * Mean shortfall against the requested reduction, in kW. The canonical scenario
   * expects ~490 kW delivered against a 500 kW request (spec §11).
   */
  readonly meanShortfallKw?: number;
  readonly faults?: readonly FaultKind[];
}

export interface SimulatedInterval {
  readonly index: number;
  readonly measuredAt: string;
  /** Facility power. null when the interval is missing (fault injection). */
  readonly facilityPowerKw: MilliKw | null;
  readonly reductionKw: MilliKw;
  readonly inletTempC: number;
  readonly simulated: true;
}

export interface SimulationResult {
  readonly simulatorVersion: string;
  readonly seed: number;
  readonly intervalSeconds: number;
  readonly normalLoadKw: MilliKw;
  readonly sustain: readonly SimulatedInterval[];
  readonly faults: readonly FaultKind[];
  readonly simulated: true;
}

/**
 * Generates the sustain window of a drill — the committed period against which
 * MRV is measured. Ramp-up and ramp-down sit outside this window, consistent
 * with the committed-energy definition in spec §14.
 */
export function simulateDrill(options: SimulationOptions): SimulationResult {
  const intervalSeconds = options.intervalSeconds ?? CANONICAL_DRILL.intervalSeconds;
  const sustainMinutes = options.sustainMinutes ?? CANONICAL_DRILL.sustainMinutes;
  const requestedKw = options.requestedReductionKw ?? CANONICAL_DRILL.requestedReductionKw;
  const normalKw = options.normalLoadKw ?? CANONICAL_FACILITY.normalLoadKw;
  const meanShortfallKw = options.meanShortfallKw ?? 10;
  const faults = options.faults ?? [];

  const intervalCount = Math.round((sustainMinutes * 60) / intervalSeconds);
  const rng = createRng(options.seed);

  const normalLoad = kwNumberToMilliKw(normalKw);
  const requested = kwNumberToMilliKw(requestedKw);
  const meanShortfall = kwNumberToMilliKw(meanShortfallKw);
  // Deterministic jitter band around the mean shortfall, in milli-kW.
  const jitterBandMilliKw = 4_000;

  const missingIndexes = new Set<number>();
  if (faults.includes('MISSING_INTERVALS')) {
    // Two non-consecutive gaps: enough to be visible, below the "more than two
    // consecutive missing intervals" certification blocker in spec §10.2.
    missingIndexes.add(Math.floor(intervalCount / 3));
    missingIndexes.add(Math.floor((2 * intervalCount) / 3));
  }
  if (faults.includes('STALE_TELEMETRY')) {
    // Telemetry stops partway and never resumes.
    for (let index = Math.floor(intervalCount / 2); index < intervalCount; index += 1) {
      missingIndexes.add(index);
    }
  }

  const sustain: SimulatedInterval[] = [];
  const startMs = Date.UTC(2026, 6, 21, 12, 0, 0);

  for (let index = 0; index < intervalCount; index += 1) {
    const draw = rng();
    const jitter = uniformInt(draw, -jitterBandMilliKw, jitterBandMilliKw);
    const shortfall = meanShortfall + BigInt(jitter);

    let reduction = requested - shortfall;
    if (reduction < 0n) reduction = 0n;

    // A thermal violation forces an early, sharp curtailment of the response.
    const thermalTripIndex = Math.floor(intervalCount * 0.6);
    if (faults.includes('THERMAL_VIOLATION') && index >= thermalTripIndex) {
      reduction = 0n;
    }

    const measuredAt = new Date(startMs + index * intervalSeconds * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');

    const missing = missingIndexes.has(index);
    const inletTempC =
      faults.includes('THERMAL_VIOLATION') && index >= thermalTripIndex ? 34 : 24;

    sustain.push({
      index,
      measuredAt,
      facilityPowerKw: missing ? null : normalLoad - reduction,
      reductionKw: reduction,
      inletTempC,
      simulated: true,
    });
  }

  return {
    simulatorVersion: SIMULATOR_VERSION,
    seed: options.seed,
    intervalSeconds,
    normalLoadKw: normalLoad,
    sustain,
    faults,
    simulated: true,
  };
}

/**
 * Builds the historical days used for baseline selection. Pre-event days sit at
 * normal load with mild deterministic variation.
 */
export function simulateBaselineDays(options: {
  readonly seed: number;
  readonly dayCount: number;
  readonly intervalCount: number;
  readonly normalLoadKw?: number;
}): { readonly date: string; readonly samples: { measuredAt: string; power: MilliKw }[] }[] {
  const normalLoad = kwNumberToMilliKw(options.normalLoadKw ?? CANONICAL_FACILITY.normalLoadKw);
  const rng = createRng(options.seed ^ 0x5eed);

  return Array.from({ length: options.dayCount }, (_, dayIndex) => {
    const date = new Date(Date.UTC(2026, 6, 20 - dayIndex)).toISOString().slice(0, 10);
    const samples = Array.from({ length: options.intervalCount }, (_, index) => {
      const jitter = uniformInt(rng(), -3_000, 3_000);
      return {
        measuredAt: `${date}T12:${String(index).padStart(2, '0')}:00Z`,
        power: normalLoad + BigInt(jitter),
      };
    });
    return { date, samples };
  });
}
