/**
 * Phase D exit criterion (spec §23):
 *   "canonical drill produces 240-250 kWh and 9,600-10,000 bps with zero violations"
 * and spec §14: "The canonical scenario must yield 240-250 kWh and 9,600-10,000 bps."
 *
 * This is the acceptance gate for the whole assurance chain. It must be driven by
 * the simulator and MRV engine end to end — never by hand-picked numbers.
 */
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_DRILL,
  CANONICAL_FACILITY,
  simulateBaselineDays,
  simulateDrill,
} from '../src/simulator/index.js';
import { computeBaseline, computeMrv } from '../src/mrv/index.js';
import { energyWh, kwNumberToMilliKw } from '../src/units.js';
import { sealDocument } from '../src/canonical-json/index.js';

const SEED = 20260721;

function runCanonicalScenario(seed: number) {
  const simulation = simulateDrill({ seed });
  const intervalCount = simulation.sustain.length;

  const baseline = computeBaseline({
    eligibleDays: simulateBaselineDays({ seed, dayCount: 5, intervalCount }),
    precedingNonEventSamples: [],
    intervalCount,
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

  return { simulation, baseline, mrv, committedEnergyWh };
}

describe('canonical scenario acceptance gate', () => {
  const { simulation, mrv, committedEnergyWh } = runCanonicalScenario(SEED);

  it('commits 250 kWh for a 500 kW, 30-minute drill', () => {
    expect(committedEnergyWh).toBe(250_000n);
  });

  it('delivers 240-250 kWh (spec 14)', () => {
    const deliveredKwh = Number(mrv.deliveredEnergyWh) / 1000;
    expect(deliveredKwh).toBeGreaterThanOrEqual(240);
    expect(deliveredKwh).toBeLessThanOrEqual(250);
  });

  it('achieves 9,600-10,000 bps performance (spec 14)', () => {
    expect(mrv.performanceBps).toBeGreaterThanOrEqual(9_600);
    expect(mrv.performanceBps).toBeLessThanOrEqual(10_000);
  });

  it('averages approximately 490 kW delivered (spec 11)', () => {
    const averageKw = Number(mrv.averageDeliveredKw);
    expect(averageKw).toBeGreaterThan(480);
    expect(averageKw).toBeLessThan(500);
  });

  it('records complete telemetry with no gaps', () => {
    expect(mrv.telemetryCompleteness).toBe(1);
    expect(mrv.maximumGapIntervals).toBe(0);
    expect(mrv.qualityBlocks).toEqual([]);
  });

  it('never drops below the minimum safe load (safety invariant, spec 13.1)', () => {
    const floor = kwNumberToMilliKw(CANONICAL_FACILITY.minimumSafeLoadKw);
    for (const interval of simulation.sustain) {
      expect(interval.facilityPowerKw).not.toBeNull();
      expect(interval.facilityPowerKw! >= floor).toBe(true);
    }
  });

  it('never exceeds the maximum curtailment', () => {
    const cap = kwNumberToMilliKw(CANONICAL_FACILITY.maximumCurtailmentKw);
    for (const interval of simulation.sustain) {
      expect(interval.reductionKw <= cap).toBe(true);
    }
  });
});

describe('simulator determinism (spec 11)', () => {
  it('produces byte-identical MRV output for the same seed', () => {
    const first = runCanonicalScenario(SEED);
    const second = runCanonicalScenario(SEED);

    expect(second.mrv.deliveredEnergyWh).toBe(first.mrv.deliveredEnergyWh);
    expect(second.mrv.performanceBps).toBe(first.mrv.performanceBps);

    // The strongest form of the claim: the sealed evidence hashes match.
    const seal = (result: typeof first) =>
      sealDocument({
        deliveredEnergyWh: result.mrv.deliveredEnergyWh,
        performanceBps: result.mrv.performanceBps,
        averageDeliveredKw: result.mrv.averageDeliveredKw,
        baselineMethod: result.mrv.baselineMethod,
        methodologyVersion: result.mrv.methodologyVersion,
      }).sha256;

    expect(seal(second)).toBe(seal(first));
  });

  it('produces different telemetry for a different seed', () => {
    const other = runCanonicalScenario(SEED + 1);
    const base = runCanonicalScenario(SEED);
    expect(other.simulation.sustain.map((i) => i.reductionKw)).not.toEqual(
      base.simulation.sustain.map((i) => i.reductionKw),
    );
  });

  it('still lands inside the acceptance range across many seeds', () => {
    // The gate must hold for the scenario generally, not just one lucky seed.
    for (let seed = 1; seed <= 25; seed += 1) {
      const { mrv } = runCanonicalScenario(seed);
      const deliveredKwh = Number(mrv.deliveredEnergyWh) / 1000;
      expect(deliveredKwh, `seed ${seed} delivered ${deliveredKwh} kWh`).toBeGreaterThanOrEqual(240);
      expect(deliveredKwh, `seed ${seed} delivered ${deliveredKwh} kWh`).toBeLessThanOrEqual(250);
      expect(mrv.performanceBps, `seed ${seed}`).toBeGreaterThanOrEqual(9_600);
      expect(mrv.performanceBps, `seed ${seed}`).toBeLessThanOrEqual(10_000);
    }
  });
});

describe('fault injection (spec 11)', () => {
  it('MISSING_INTERVALS degrades completeness and is reported, not hidden', () => {
    const simulation = simulateDrill({ seed: SEED, faults: ['MISSING_INTERVALS'] });
    const intervalCount = simulation.sustain.length;
    const baseline = computeBaseline({
      eligibleDays: simulateBaselineDays({ seed: SEED, dayCount: 5, intervalCount }),
      precedingNonEventSamples: [],
      intervalCount,
    });

    const mrv = computeMrv({
      baseline,
      actual: simulation.sustain.map((i) => ({
        measuredAt: i.measuredAt,
        power: i.facilityPowerKw,
      })),
      intervalSeconds: simulation.intervalSeconds,
      committedEnergyWh: 250_000n,
    });

    expect(mrv.telemetryCompleteness).toBeLessThan(1);
    expect(mrv.qualityBlocks.length).toBeGreaterThan(0);
    // Missing intervals must LOWER the certified claim, never raise it.
    expect(mrv.deliveredEnergyWh).toBeLessThan(245_000n);
  });

  it('STALE_TELEMETRY drives completeness below the 90% certification floor', () => {
    const simulation = simulateDrill({ seed: SEED, faults: ['STALE_TELEMETRY'] });
    const intervalCount = simulation.sustain.length;
    const baseline = computeBaseline({
      eligibleDays: simulateBaselineDays({ seed: SEED, dayCount: 5, intervalCount }),
      precedingNonEventSamples: [],
      intervalCount,
    });

    const mrv = computeMrv({
      baseline,
      actual: simulation.sustain.map((i) => ({
        measuredAt: i.measuredAt,
        power: i.facilityPowerKw,
      })),
      intervalSeconds: simulation.intervalSeconds,
      committedEnergyWh: 250_000n,
    });

    // Spec 10.2: drill certification is blocked below 90% completeness.
    expect(mrv.telemetryCompleteness).toBeLessThan(0.9);
  });

  it('THERMAL_VIOLATION collapses delivery below the acceptance range', () => {
    const simulation = simulateDrill({ seed: SEED, faults: ['THERMAL_VIOLATION'] });
    const intervalCount = simulation.sustain.length;
    const baseline = computeBaseline({
      eligibleDays: simulateBaselineDays({ seed: SEED, dayCount: 5, intervalCount }),
      precedingNonEventSamples: [],
      intervalCount,
    });

    const mrv = computeMrv({
      baseline,
      actual: simulation.sustain.map((i) => ({
        measuredAt: i.measuredAt,
        power: i.facilityPowerKw,
      })),
      intervalSeconds: simulation.intervalSeconds,
      committedEnergyWh: 250_000n,
    });

    expect(mrv.performanceBps).toBeLessThan(9_600);
  });
});
