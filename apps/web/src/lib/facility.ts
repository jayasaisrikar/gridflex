/**
 * Canonical demo values.
 *
 * IMPORTANT — nothing here is invented. Every number below is either:
 *   (a) seeded configuration from infra/sql/gridflex_seed.sql, or
 *   (b) computed by @gridflex/engine and verified by its test suite.
 *
 * The MRV figures are the actual output of the canonical scenario
 * (seed 20260721), asserted in packages/engine/tests/canonical-scenario.test.ts
 * to fall inside the spec §14 acceptance range. They are not illustrative.
 *
 * When the API is wired in, this module is replaced by fetches — the shape
 * stays the same so the components do not change.
 */

export const FACILITY = {
  name: 'Lone Star Compute Facility',
  slug: 'lone-star-compute',
  timezone: 'America/Chicago',
  market: 'ERCOT',
  region: 'Texas',
  // From gridflex_seed.sql
  normalLoadKw: '1600.000',
  minimumSafeLoadKw: '900.000',
  maximumCurtailmentKw: '600.000',
  rampRateKwPerMin: '100.000',
  coolingReserveKw: '150.000',
} as const;

export const CONSTRAINTS = {
  version: 1,
  minimumSafeLoadKw: '900.000',
  maximumCurtailmentKw: '600.000',
  maximumRampKwPerMin: '100.000',
  maximumDurationMin: 60,
  minimumRecoveryMin: 30,
  maximumReboundKw: '250.000',
  thermalLimitC: '32.000',
  sourceNote: 'Canonical demo constraints',
} as const;

/** From gridflex_seed.sql. All three are DECLARED — no drill has tested them yet. */
export const MECHANISMS = [
  {
    code: 'WORKLOAD_DEFERRAL',
    name: 'Batch workload deferral',
    type: 'WORKLOAD',
    declaredKw: '350.000',
    rampKwPerMin: '80.000',
    durationMin: 60,
    reboundWindowMin: 20,
    provenance: 'DECLARED' as const,
  },
  {
    code: 'COOLING_HEADROOM',
    name: 'Cooling thermal headroom',
    type: 'COOLING',
    declaredKw: '100.000',
    rampKwPerMin: '20.000',
    durationMin: 30,
    reboundWindowMin: 30,
    provenance: 'DECLARED' as const,
  },
  {
    code: 'UPS_BESS',
    name: 'UPS/BESS discharge support',
    type: 'STORAGE',
    declaredKw: '150.000',
    rampKwPerMin: '150.000',
    durationMin: 30,
    reboundWindowMin: 45,
    provenance: 'DECLARED' as const,
  },
] as const;

/**
 * Envelope as computed by @gridflex/engine from the values above.
 * Verified in packages/engine/tests/envelope.test.ts.
 */
export const ENVELOPE = {
  version: 1,
  status: 'CURRENT' as const,
  totalReducibleKw: '600.000',
  // min(sum of caps 600, physical headroom 700, max curtailment 600)
  bindingConstraint: 'MAXIMUM_CURTAILMENT',
  sumOfMechanismCapsKw: '600.000',
  physicalHeadroomKw: '700.000',
  aggregateRampKwPerMin: '100.000',
  sustainableDurationMin: 30,
  responseTimeSeconds: 60,
  confidenceScore: 0.3,
  telemetryCompleteness: 0.98,
  methodologyVersion: 'gridflex-envelope-1.0.0',
  constraintsVersion: 1,
} as const;

/**
 * MRV output of the canonical drill, seed 20260721.
 * Asserted against spec §14's acceptance range by the engine test suite.
 */
export const DRILL = {
  name: 'Canonical 500 kW · 30 min',
  status: 'COMPLETED' as const,
  simulationMode: true,
  requestedReductionKw: '500.000',
  sustainMinutes: 30,
  intervalSeconds: 60,
  baselineMethod: 'MEDIAN_SAME_INTERVAL_5_DAYS',
  committedEnergyKwh: '250.000',
  deliveredEnergyKwh: '244.724',
  averageDeliveredKw: '489.447',
  performanceBps: 9789,
  telemetryCompleteness: 1,
  maximumGapIntervals: 0,
  methodologyVersion: 'gridflex-mrv-1.0.0',
  seed: 20260721,
} as const;

/** Evidence digest produced by sealDocument() over the MRV result. */
export const EVIDENCE = {
  schemaVersion: 'gridflex-canonical-1',
  sha256: '66820ce67fa39e82b170c8adcdeafe89dee7b3316d030b18003990ef5af8baf2',
} as const;

/** Formats basis points as a percentage string, e.g. 9789 → "97.89". */
export function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2);
}
