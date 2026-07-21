import { describe, expect, it } from 'vitest';
import type { Anomaly } from '../src/anomaly/index.js';
import {
  MINIMUM_CORRECTION_FACTOR,
  MINIMUM_OUTCOMES_FOR_CORRECTION,
  applyCorrection,
  describeCorrection,
  learnFromOutcomes,
  type DrillOutcome,
} from '../src/learning/index.js';

function outcomeOf(overrides: Partial<DrillOutcome> = {}): DrillOutcome {
  return {
    drillId: 'd1',
    completedAt: '2026-07-01T12:00:00Z',
    predictedReducibleMkw: 500_000n,
    deliveredReducibleMkw: 500_000n,
    predictedRampSeconds: 120,
    actualRampSeconds: 120,
    predictedReboundMkw: 100_000n,
    actualReboundMkw: 100_000n,
    anomalies: [],
    simulated: false,
    ...overrides,
  };
}

const ANOMALY: Anomaly = {
  code: 'METER_STUCK',
  severity: 'WARNING',
  detail: '',
  at: null,
  facts: {},
};

function repeat(count: number, overrides: Partial<DrillOutcome> = {}): DrillOutcome[] {
  return Array.from({ length: count }, (_, i) => outcomeOf({ drillId: `d${i}`, ...overrides }));
}

describe('learnFromOutcomes — the correction may only be conservative', () => {
  it('scales forecasts DOWN when the facility under-delivers', () => {
    const result = learnFromOutcomes(repeat(5, { deliveredReducibleMkw: 400_000n }));
    expect(result.applied).toBe(true);
    expect(result.correctionFactor).toBe(0.8);
    expect(result.medianDeliveryRatio).toBe(0.8);
  });

  it('does NOT scale forecasts up when the facility over-delivers', () => {
    // A lucky streak must not talk the model into promising unverified capacity.
    // A larger claim has to come from the envelope on tested evidence.
    const result = learnFromOutcomes(repeat(5, { deliveredReducibleMkw: 750_000n }));
    expect(result.correctionFactor).toBe(1);
    expect(result.applied).toBe(false);
    expect(result.medianDeliveryRatio).toBe(1.5);
    expect(result.notes.join(' ')).toMatch(/No upward\s+correction is applied/);
  });

  it('floors the correction so a model is never scaled to nothing', () => {
    const result = learnFromOutcomes(repeat(5, { deliveredReducibleMkw: 10_000n }));
    expect(result.correctionFactor).toBe(MINIMUM_CORRECTION_FACTOR);
  });

  it('uses the MEDIAN ratio, so one bad drill cannot dominate', () => {
    const outcomes = [
      ...repeat(4, { deliveredReducibleMkw: 500_000n }),
      outcomeOf({ drillId: 'bad', deliveredReducibleMkw: 5_000n }),
    ];
    const result = learnFromOutcomes(outcomes);
    expect(result.medianDeliveryRatio).toBe(1);
    expect(result.applied).toBe(false);
  });
});

describe('learnFromOutcomes — what is excluded from learning', () => {
  it('excludes anomalous drills', () => {
    // Learning from a drill where the meter was stuck would bake the fault in.
    const outcomes = [...repeat(3), outcomeOf({ drillId: 'anom', anomalies: [ANOMALY] })];
    const result = learnFromOutcomes(outcomes);

    expect(result.outcomesUsed).toBe(3);
    expect(result.outcomesExcluded).toHaveLength(1);
    expect(result.outcomesExcluded[0]?.reason).toBe('ANOMALOUS:METER_STUCK');
  });

  it('excludes simulated drills', () => {
    // A simulated drill proves the pipeline works, not that the facility does.
    const outcomes = [...repeat(3), outcomeOf({ drillId: 'sim', simulated: true })];
    const result = learnFromOutcomes(outcomes);

    expect(result.outcomesUsed).toBe(3);
    expect(result.outcomesExcluded[0]?.reason).toBe('SIMULATED');
  });

  it('excludes drills with no prediction to compare against', () => {
    const outcomes = [...repeat(3), outcomeOf({ drillId: 'np', predictedReducibleMkw: 0n })];
    const result = learnFromOutcomes(outcomes);
    expect(result.outcomesExcluded[0]?.reason).toBe('NO_PREDICTION');
  });

  it('lists every excluded drill with its reason', () => {
    const outcomes = [
      outcomeOf({ drillId: 'a', simulated: true }),
      outcomeOf({ drillId: 'b', anomalies: [ANOMALY] }),
      outcomeOf({ drillId: 'c', predictedReducibleMkw: 0n }),
    ];
    const result = learnFromOutcomes(outcomes);
    expect(result.outcomesExcluded.map((e) => e.drillId)).toEqual(['a', 'b', 'c']);
    expect(result.outcomesUsed).toBe(0);
  });
});

describe('learnFromOutcomes — evidence threshold', () => {
  it('applies no correction below the minimum outcome count', () => {
    const result = learnFromOutcomes(
      repeat(MINIMUM_OUTCOMES_FOR_CORRECTION - 1, { deliveredReducibleMkw: 250_000n }),
    );
    expect(result.applied).toBe(false);
    expect(result.correctionFactor).toBe(1);
    expect(result.notes.join(' ')).toMatch(/are required before/);
  });

  it('applies a correction at exactly the minimum count', () => {
    const result = learnFromOutcomes(
      repeat(MINIMUM_OUTCOMES_FOR_CORRECTION, { deliveredReducibleMkw: 250_000n }),
    );
    expect(result.applied).toBe(true);
  });

  it('still reports the observed ratios below the threshold', () => {
    // Useful diagnostics even when not yet actionable.
    const result = learnFromOutcomes(repeat(2, { deliveredReducibleMkw: 250_000n }));
    expect(result.medianDeliveryRatio).toBe(0.5);
    expect(result.applied).toBe(false);
  });

  it('handles an empty outcome list', () => {
    const result = learnFromOutcomes([]);
    expect(result.correctionFactor).toBe(1);
    expect(result.medianDeliveryRatio).toBeNull();
    expect(result.applied).toBe(false);
  });
});

describe('learnFromOutcomes — ramp and rebound diagnostics', () => {
  it('notes when the facility ramps slower than predicted', () => {
    const result = learnFromOutcomes(repeat(4, { actualRampSeconds: 300, predictedRampSeconds: 120 }));
    expect(result.medianRampRatio).toBe(2.5);
    expect(result.notes.join(' ')).toMatch(/ramps a median 2.50x slower/);
  });

  it('notes when rebound exceeds prediction', () => {
    const result = learnFromOutcomes(
      repeat(4, { actualReboundMkw: 200_000n, predictedReboundMkw: 100_000n }),
    );
    expect(result.medianReboundRatio).toBe(2);
    expect(result.notes.join(' ')).toMatch(/Rebound runs a median 2.00x above/);
  });

  it('stays quiet when ramp and rebound match prediction', () => {
    const result = learnFromOutcomes(repeat(4));
    expect(result.notes.join(' ')).not.toMatch(/slower than predicted|above prediction/);
  });

  it('ignores a zero predicted ramp rather than dividing by zero', () => {
    const result = learnFromOutcomes(repeat(4, { predictedRampSeconds: 0 }));
    expect(result.medianRampRatio).toBeNull();
  });
});

describe('applyCorrection', () => {
  it('scales a forecast down exactly', () => {
    expect(applyCorrection(500_000n, 0.8)).toBe(400_000n);
  });

  it('is a no-op at factor 1', () => {
    expect(applyCorrection(500_000n, 1)).toBe(500_000n);
  });

  it('REFUSES a factor above 1', () => {
    // The type system cannot express "only reduces", so the guard is explicit.
    expect(() => applyCorrection(500_000n, 1.5)).toThrow(/may only reduce a forecast/);
  });

  it('refuses a zero or negative factor', () => {
    expect(() => applyCorrection(500_000n, 0)).toThrow(/may only reduce/);
    expect(() => applyCorrection(500_000n, -0.5)).toThrow(/may only reduce/);
  });

  it('never returns a negative result', () => {
    expect(applyCorrection(0n, 0.5)).toBe(0n);
  });

  it('rounds half away from zero, matching the engine', () => {
    // 1n * 0.5 = 0.5 => rounds to 1, not 0.
    expect(applyCorrection(1n, 0.5)).toBe(1n);
  });
});

describe('describeCorrection', () => {
  it('describes an applied correction', () => {
    const result = learnFromOutcomes(repeat(5, { deliveredReducibleMkw: 400_000n }));
    expect(describeCorrection(result)).toMatch(/Forecasts scaled to 80.0%/);
  });

  it('describes the absence of one', () => {
    expect(describeCorrection(learnFromOutcomes([]))).toMatch(/No correction applied/);
  });
});
