import { describe, expect, it } from 'vitest';
import {
  BASE_CONFIDENCE,
  CONFIDENCE_CAP_WITHOUT_EXTERNAL_REVIEW,
  computeEnvelope,
  type EnvelopeInput,
  type MechanismInput,
} from '../src/envelope/index.js';

/** Mechanisms from gridflex_seed.sql, all DECLARED at first. */
const seedMechanisms: MechanismInput[] = [
  {
    id: 'm1',
    code: 'WORKLOAD_DEFERRAL',
    name: 'Batch workload deferral',
    enabled: true,
    declaredReducibleKw: 350,
    observedReducibleKw: null,
    constraintCapKw: null,
    rampKwPerMin: 80,
    maximumDurationMin: 60,
    reboundWindowMin: 20,
    testedReducibleKw: null,
    testCount: 0,
  },
  {
    id: 'm2',
    code: 'COOLING_HEADROOM',
    name: 'Cooling thermal headroom',
    enabled: true,
    declaredReducibleKw: 100,
    observedReducibleKw: null,
    constraintCapKw: null,
    rampKwPerMin: 20,
    maximumDurationMin: 30,
    reboundWindowMin: 30,
    testedReducibleKw: null,
    testCount: 0,
  },
  {
    id: 'm3',
    code: 'UPS_BESS',
    name: 'UPS/BESS discharge support',
    enabled: true,
    declaredReducibleKw: 150,
    observedReducibleKw: null,
    constraintCapKw: null,
    rampKwPerMin: 150,
    maximumDurationMin: 30,
    reboundWindowMin: 45,
    testedReducibleKw: null,
    testCount: 0,
  },
];

const baseInput: EnvelopeInput = {
  mechanisms: seedMechanisms,
  p50NormalLoadKw: 1600,
  minimumSafeLoadKw: 900,
  maximumCurtailmentKw: 600,
  maximumRampKwPerMin: 100,
  maximumDurationMin: 60,
  telemetryCompleteness: 0.98,
  modelingWindowDays: 14,
  constraintsVersion: 1,
  constraintsAgeDays: 10,
  hasExternalReview: false,
};

describe('canonical facility envelope (spec 12.2)', () => {
  const result = computeEnvelope(baseInput);

  it('caps the total at maximum curtailment, which binds here', () => {
    // Mechanism caps sum to 600; physical headroom is 1600-900 = 700;
    // maximum curtailment is 600. min(600, 700, 600) = 600.
    expect(result.totalReducibleKw).toBe('600.000');
  });

  it('names the binding constraint so the number can be explained', () => {
    expect(['SUM_OF_MECHANISM_CAPS', 'MAXIMUM_CURTAILMENT']).toContain(result.bindingConstraint);
  });

  it('caps aggregate ramp at the facility limit, not the sum of mechanisms', () => {
    // Mechanism ramps sum to 250 kW/min but the facility permits 100.
    expect(result.aggregateRampKwPerMin).toBe('100.000');
  });

  it('sustains only as long as the weakest contributing mechanism', () => {
    // Cooling and UPS are 30 min; workload deferral is 60.
    expect(result.sustainableDurationMin).toBe(30);
  });

  it('marks every mechanism DECLARED when there is no telemetry or test history', () => {
    expect(result.mechanisms.map((m) => m.provenance)).toEqual([
      'DECLARED',
      'DECLARED',
      'DECLARED',
    ]);
  });

  it('is conservative: a fully declared envelope earns low confidence', () => {
    expect(result.confidenceScore).toBeLessThanOrEqual(BASE_CONFIDENCE.DECLARED);
    expect(result.status).toBe('DRAFT');
  });

  it('records a decision for every mechanism plus the aggregation', () => {
    expect(result.decisions.filter((d) => d.decisionCode === 'MECHANISM_CAP_SELECTED')).toHaveLength(3);
    expect(result.decisions.some((d) => d.decisionCode === 'TOTAL_REDUCIBLE_CAPPED')).toBe(true);
  });

  it('is deterministic', () => {
    expect(computeEnvelope(baseInput)).toEqual(computeEnvelope(baseInput));
  });
});

describe('cap selection (spec 12.2)', () => {
  it('takes the minimum across declared, observed, and constraint caps', () => {
    const result = computeEnvelope({
      ...baseInput,
      mechanisms: [
        {
          ...seedMechanisms[0]!,
          declaredReducibleKw: 350,
          observedReducibleKw: 280,
          constraintCapKw: 300,
        },
      ],
    });
    expect(result.mechanisms[0]?.reducibleKw).toBe('280.000');
    expect(result.mechanisms[0]?.bindingCap).toBe('OBSERVED');
  });

  it('promotes provenance to MODELED when telemetry supports a cap', () => {
    const result = computeEnvelope({
      ...baseInput,
      mechanisms: [{ ...seedMechanisms[0]!, observedReducibleKw: 300 }],
    });
    expect(result.mechanisms[0]?.provenance).toBe('MODELED');
  });

  it('promotes provenance to TESTED only when a test actually ran', () => {
    const untested = computeEnvelope({
      ...baseInput,
      mechanisms: [{ ...seedMechanisms[0]!, testedReducibleKw: 320, testCount: 0 }],
    });
    expect(untested.mechanisms[0]?.provenance).not.toBe('TESTED');

    const tested = computeEnvelope({
      ...baseInput,
      mechanisms: [{ ...seedMechanisms[0]!, testedReducibleKw: 320, testCount: 1 }],
    });
    expect(tested.mechanisms[0]?.provenance).toBe('TESTED');
  });

  it('treats a mechanism with no capacity data as zero and flags it', () => {
    const result = computeEnvelope({
      ...baseInput,
      mechanisms: [
        {
          ...seedMechanisms[0]!,
          declaredReducibleKw: null,
          observedReducibleKw: null,
          constraintCapKw: null,
          testedReducibleKw: null,
        },
      ],
    });
    expect(result.mechanisms[0]?.reducibleKw).toBe('0.000');
    expect(result.decisions.some((d) => d.decisionCode === 'MECHANISM_NO_CAPACITY_DATA')).toBe(true);
  });

  it('ignores disabled mechanisms', () => {
    const result = computeEnvelope({
      ...baseInput,
      mechanisms: seedMechanisms.map((m, i) => (i === 0 ? { ...m, enabled: false } : m)),
    });
    expect(result.mechanisms).toHaveLength(2);
    expect(result.totalReducibleKw).toBe('250.000'); // 100 + 150
  });
});

describe('physical headroom cap', () => {
  it('binds when headroom is lower than the mechanism sum', () => {
    const result = computeEnvelope({
      ...baseInput,
      p50NormalLoadKw: 1200,
      minimumSafeLoadKw: 900, // headroom = 300
    });
    expect(result.totalReducibleKw).toBe('300.000');
    expect(result.bindingConstraint).toBe('PHYSICAL_HEADROOM');
  });

  it('never returns negative headroom when load sits below the safe floor', () => {
    const result = computeEnvelope({
      ...baseInput,
      p50NormalLoadKw: 800,
      minimumSafeLoadKw: 900,
    });
    expect(result.totalReducibleKw).toBe('0.000');
  });
});

describe('data-quality gate (spec 10.2)', () => {
  it('blocks below 90% completeness and asserts no capacity', () => {
    const result = computeEnvelope({ ...baseInput, telemetryCompleteness: 0.85 });
    expect(result.status).toBe('BLOCKED');
    expect(result.totalReducibleKw).toBe('0.000');
    expect(result.confidenceScore).toBe(0);
    expect(result.blockedReasons.some((r) => r.code === 'ENVELOPE_BLOCKED_DATA_QUALITY')).toBe(true);
  });

  it('records a BLOCKER decision with the numbers that caused it', () => {
    const result = computeEnvelope({ ...baseInput, telemetryCompleteness: 0.85 });
    const decision = result.decisions.find((d) => d.severity === 'BLOCKER');
    expect(decision?.facts).toMatchObject({ completeness: 0.85, required: 0.9 });
  });

  it('blocks when no mechanism is enabled', () => {
    const result = computeEnvelope({
      ...baseInput,
      mechanisms: seedMechanisms.map((m) => ({ ...m, enabled: false })),
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.blockedReasons.some((r) => r.code === 'NO_ENABLED_MECHANISMS')).toBe(true);
  });
});

describe('confidence (spec 12.2)', () => {
  it('starts from the weakest mechanism, not the average', () => {
    const result = computeEnvelope({
      ...baseInput,
      telemetryCompleteness: 0.98,
      mechanisms: [
        { ...seedMechanisms[0]!, testedReducibleKw: 350, testCount: 3 }, // TESTED 0.85
        seedMechanisms[1]!, // DECLARED 0.35
      ],
    });
    // One DECLARED mechanism drags the aggregate down to its level.
    expect(result.confidenceScore).toBeLessThanOrEqual(BASE_CONFIDENCE.DECLARED);
  });

  it('penalises a short modeling window and reports the adjustment', () => {
    const short = computeEnvelope({ ...baseInput, modelingWindowDays: 3 });
    const full = computeEnvelope(baseInput);
    expect(short.confidenceScore).toBeLessThan(full.confidenceScore);
    expect(short.confidenceAdjustments.some((a) => a.code === 'SHORT_MODELING_WINDOW')).toBe(true);
  });

  it('penalises stale constraints', () => {
    const stale = computeEnvelope({ ...baseInput, constraintsAgeDays: 400 });
    expect(stale.confidenceAdjustments.some((a) => a.code === 'STALE_CONSTRAINTS')).toBe(true);
  });

  it('caps confidence at 0.95 without external review', () => {
    const result = computeEnvelope({
      ...baseInput,
      telemetryCompleteness: 1,
      modelingWindowDays: 30,
      constraintsAgeDays: 1,
      mechanisms: seedMechanisms.map((m) => ({
        ...m,
        testedReducibleKw: m.declaredReducibleKw,
        testCount: 5,
      })),
    });
    expect(result.confidenceScore).toBeLessThanOrEqual(CONFIDENCE_CAP_WITHOUT_EXTERNAL_REVIEW);
  });

  it('never returns confidence outside [0,1]', () => {
    const result = computeEnvelope({
      ...baseInput,
      telemetryCompleteness: 0.91,
      modelingWindowDays: 1,
      constraintsAgeDays: 9999,
    });
    expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(result.confidenceScore).toBeLessThanOrEqual(1);
  });

  it('reports every adjustment so the score can be explained line by line', () => {
    const result = computeEnvelope({ ...baseInput, modelingWindowDays: 3, constraintsAgeDays: 400 });
    const codes = result.confidenceAdjustments.map((a) => a.code);
    expect(codes).toContain('BASE_WEAKEST_PROVENANCE');
    expect(codes).toContain('SHORT_MODELING_WINDOW');
    expect(codes).toContain('STALE_CONSTRAINTS');
  });
});
