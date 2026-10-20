/**
 * Canonical demo values — UAE profile.
 *
 * IMPORTANT — nothing here is invented. Every number below is either:
 *   (a) seeded configuration from infra/sql/gridflex_seed.sql, or
 *   (b) computed by @gridflex/engine and verified by its test suite.
 *
 * The demo facility is a 10 MW data centre in Dubai on the DEWA network.
 * Drill MRV figures come from packages/db/scripts/seed-simulation running the
 * engine at Dubai scale (seed 20260721) — they are computed, not asserted
 * here, so this file carries no hard-coded delivered figure that could drift
 * from the sealed evidence.
 *
 * When the API is wired in, this module is replaced by fetches — the shape
 * stays the same so the components do not change.
 */

export const FACILITY = {
  name: 'Dubai Compute Campus',
  slug: 'dubai-compute-campus',
  timezone: 'Asia/Dubai',
  market: 'DEWA',
  region: 'Dubai',
  country: 'AE',
  currency: 'AED',
  // From gridflex_seed.sql
  normalLoadKw: '10000.000',
  minimumSafeLoadKw: '6000.000',
  maximumCurtailmentKw: '3500.000',
  rampRateKwPerMin: '800.000',
  coolingReserveKw: '2500.000',
} as const;

export const CONSTRAINTS = {
  version: 1,
  minimumSafeLoadKw: '6000.000',
  maximumCurtailmentKw: '3500.000',
  maximumRampKwPerMin: '800.000',
  maximumDurationMin: 240,
  minimumRecoveryMin: 30,
  maximumReboundKw: '1200.000',
  thermalLimitC: '30.000',
  sourceNote: 'Dubai demo constraints (DEWA summer profile)',
} as const;

/** From gridflex_seed.sql. All four are DECLARED — no drill has tested them yet. */
export const MECHANISMS = [
  {
    code: 'COOLING_PRECOOL',
    name: 'Chilled-water pre-cooling (thermal bank)',
    type: 'COOLING',
    declaredKw: '1200.000',
    rampKwPerMin: '300.000',
    durationMin: 90,
    reboundWindowMin: 60,
    provenance: 'DECLARED' as const,
  },
  {
    code: 'COOLING_SETPOINT_SHIFT',
    name: 'Cooling setpoint shift',
    type: 'COOLING',
    declaredKw: '800.000',
    rampKwPerMin: '100.000',
    durationMin: 240,
    reboundWindowMin: 30,
    provenance: 'DECLARED' as const,
  },
  {
    code: 'UPS_BESS',
    name: 'UPS/BESS discharge support',
    type: 'STORAGE',
    declaredKw: '1000.000',
    rampKwPerMin: '1000.000',
    durationMin: 30,
    reboundWindowMin: 45,
    provenance: 'DECLARED' as const,
  },
  {
    code: 'WORKLOAD_DEFERRAL',
    name: 'Batch workload deferral',
    type: 'WORKLOAD',
    declaredKw: '500.000',
    rampKwPerMin: '200.000',
    durationMin: 120,
    reboundWindowMin: 20,
    provenance: 'DECLARED' as const,
  },
] as const;

/**
 * Envelope as computed by @gridflex/engine from the values above:
 * min(sum of caps 3500, physical headroom 4000, max curtailment 3500).
 */
export const ENVELOPE = {
  version: 1,
  status: 'CURRENT' as const,
  totalReducibleKw: '3500.000',
  bindingConstraint: 'MAXIMUM_CURTAILMENT',
  sumOfMechanismCapsKw: '3500.000',
  physicalHeadroomKw: '4000.000',
  aggregateRampKwPerMin: '800.000',
  sustainableDurationMin: 30,
  responseTimeSeconds: 60,
  confidenceScore: 0.3,
  telemetryCompleteness: 0.98,
  methodologyVersion: 'gridflex-envelope-1.0.0',
  constraintsVersion: 1,
} as const;

/**
 * The Dubai demo drill (seed 20260721, 2,500 kW · 30 min), computed by
 * packages/db/scripts/seed-simulation through the engine. Delivered energy
 * and performance live in the sealed evidence bundle, not here.
 */
export const DRILL = {
  name: 'Dubai peak 2,500 kW · 30 min',
  status: 'COMPLETED' as const,
  simulationMode: true,
  requestedReductionKw: '2500.000',
  sustainMinutes: 30,
  intervalSeconds: 60,
  baselineMethod: 'MEDIAN_SAME_INTERVAL_5_DAYS',
  committedEnergyKwh: '1250.000',
  telemetryCompleteness: 1,
  maximumGapIntervals: 0,
  methodologyVersion: 'gridflex-mrv-1.0.0',
  seed: 20260721,
} as const;

/** Formats basis points as a percentage string, e.g. 9789 → "97.89". */
export function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2);
}
