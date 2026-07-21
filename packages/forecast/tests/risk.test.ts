import { describe, expect, it } from 'vitest';
import { planReduction, type PlanMechanismInput } from '../src/plan/index.js';
import {
  MAXIMUM_TELEMETRY_AGE_SECONDS,
  MINIMUM_BATTERY_STATE_OF_CHARGE,
  MINIMUM_THERMAL_MARGIN_C,
  RISK_ENGINE_VERSION,
  assessRisk,
  type RiskInput,
} from '../src/risk/index.js';

const MECHANISMS: PlanMechanismInput[] = [
  {
    id: 'm-workload',
    code: 'WORKLOAD_DEFERRAL',
    mechanismType: 'WORKLOAD',
    enabled: true,
    availableKw: '350.000',
    rampKwPerMin: '80.000',
    maximumDurationMin: 60,
    reboundWindowMin: 20,
  },
  {
    id: 'm-cooling',
    code: 'COOLING_HEADROOM',
    mechanismType: 'COOLING',
    enabled: true,
    availableKw: '100.000',
    rampKwPerMin: '20.000',
    maximumDurationMin: 30,
    reboundWindowMin: 30,
  },
  {
    id: 'm-storage',
    code: 'UPS_BESS',
    mechanismType: 'STORAGE',
    enabled: true,
    availableKw: '150.000',
    rampKwPerMin: '150.000',
    maximumDurationMin: 30,
    reboundWindowMin: 45,
  },
];

/** A workload-only plan: touches neither cooling nor storage. */
const workloadOnlyPlan = planReduction({
  targetReducibleKw: '300.000',
  durationMin: 30,
  mechanisms: MECHANISMS,
});

/** A plan that draws on all three, including cooling and storage. */
const fullPlan = planReduction({
  targetReducibleKw: '600.000',
  durationMin: 30,
  mechanisms: MECHANISMS,
});

function riskOf(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    plan: workloadOnlyPlan,
    envelopeConfidence: 0.85,
    envelopeStatus: 'DRAFT',
    forecastIntervalUnderpowered: false,
    telemetryAgeSeconds: 60,
    telemetryCompleteness: 1,
    thermalMarginC: 8,
    batteryStateOfCharge: 0.9,
    priorDrillCount: 4,
    priorDrillSuccessCount: 4,
    emergencyStopActive: false,
    ...overrides,
  };
}

describe('assessRisk — clean baseline', () => {
  it('reports LOW with no factors when everything is healthy', () => {
    const risk = assessRisk(riskOf());
    expect(risk.level).toBe('LOW');
    expect(risk.blocked).toBe(false);
    expect(risk.factors).toHaveLength(0);
    expect(risk.riskEngineVersion).toBe(RISK_ENGINE_VERSION);
    expect(risk.summary).toBe('No risk factors identified.');
  });

  it('is deterministic', () => {
    const input = riskOf();
    const first = assessRisk(input);
    for (let i = 0; i < 5; i += 1) expect(assessRisk(input)).toEqual(first);
  });
});

describe('assessRisk — blocking constraints', () => {
  it('blocks on an active emergency stop', () => {
    const risk = assessRisk(riskOf({ emergencyStopActive: true }));
    expect(risk.blocked).toBe(true);
    expect(risk.level).toBe('BLOCKED');
    expect(risk.factors[0]?.code).toBe('EMERGENCY_STOP_ACTIVE');
  });

  it('blocks on a BLOCKED envelope', () => {
    const risk = assessRisk(riskOf({ envelopeStatus: 'BLOCKED' }));
    expect(risk.blocked).toBe(true);
    expect(risk.factors.some((f) => f.code === 'ENVELOPE_BLOCKED')).toBe(true);
  });

  it('blocks on stale telemetry', () => {
    // Acting on a stale picture is how a minimum-load floor gets crossed
    // without anyone seeing it happen.
    const risk = assessRisk(riskOf({ telemetryAgeSeconds: MAXIMUM_TELEMETRY_AGE_SECONDS + 1 }));
    expect(risk.blocked).toBe(true);
    expect(risk.factors.some((f) => f.code === 'TELEMETRY_STALE')).toBe(true);
  });

  it('does not block telemetry exactly at the age limit', () => {
    const risk = assessRisk(riskOf({ telemetryAgeSeconds: MAXIMUM_TELEMETRY_AGE_SECONDS }));
    expect(risk.factors.some((f) => f.code === 'TELEMETRY_STALE')).toBe(false);
  });

  it('blocks an infeasible plan', () => {
    const short = planReduction({
      targetReducibleKw: '900.000',
      durationMin: 30,
      mechanisms: MECHANISMS,
    });
    const risk = assessRisk(riskOf({ plan: short }));
    expect(risk.blocked).toBe(true);
    expect(risk.factors.some((f) => f.code === 'PLAN_NOT_FEASIBLE')).toBe(true);
  });

  it('an emergency stop blocks even when everything else is perfect', () => {
    const risk = assessRisk(riskOf({ emergencyStopActive: true, envelopeConfidence: 0.95 }));
    expect(risk.level).toBe('BLOCKED');
  });
});

describe('assessRisk — thermal, assessed only when cooling is used', () => {
  it('blocks when cooling is used and margin is insufficient', () => {
    const risk = assessRisk(
      riskOf({ plan: fullPlan, thermalMarginC: MINIMUM_THERMAL_MARGIN_C - 0.5 }),
    );
    expect(risk.blocked).toBe(true);
    expect(risk.factors.some((f) => f.code === 'THERMAL_MARGIN_INSUFFICIENT')).toBe(true);
  });

  it('blocks when cooling is used and margin is unknown', () => {
    // Unknown is not the same as fine. A missing reading must not read as safe.
    const risk = assessRisk(riskOf({ plan: fullPlan, thermalMarginC: null }));
    expect(risk.blocked).toBe(true);
    expect(risk.factors.some((f) => f.code === 'THERMAL_MARGIN_UNKNOWN')).toBe(true);
  });

  it('IGNORES thermal margin when the plan does not touch cooling', () => {
    // A workload-only plan raises no setpoints, so a thin thermal margin is
    // irrelevant to it. Blocking here would refuse safe drills for no reason.
    const risk = assessRisk(riskOf({ plan: workloadOnlyPlan, thermalMarginC: null }));
    expect(risk.factors.some((f) => f.code.startsWith('THERMAL'))).toBe(false);
  });

  it('permits cooling at exactly the minimum margin', () => {
    const risk = assessRisk(riskOf({ plan: fullPlan, thermalMarginC: MINIMUM_THERMAL_MARGIN_C }));
    expect(risk.factors.some((f) => f.code === 'THERMAL_MARGIN_INSUFFICIENT')).toBe(false);
  });
});

describe('assessRisk — storage, assessed only when discharged', () => {
  it('blocks on a low state of charge', () => {
    const risk = assessRisk(
      riskOf({ plan: fullPlan, batteryStateOfCharge: MINIMUM_BATTERY_STATE_OF_CHARGE - 0.01 }),
    );
    expect(risk.blocked).toBe(true);
    expect(risk.factors.some((f) => f.code === 'BATTERY_SOC_LOW')).toBe(true);
  });

  it('blocks on an unknown state of charge', () => {
    const risk = assessRisk(riskOf({ plan: fullPlan, batteryStateOfCharge: null }));
    expect(risk.blocked).toBe(true);
    expect(risk.factors.some((f) => f.code === 'BATTERY_SOC_UNKNOWN')).toBe(true);
  });

  it('IGNORES state of charge when storage is not allocated', () => {
    const risk = assessRisk(riskOf({ plan: workloadOnlyPlan, batteryStateOfCharge: null }));
    expect(risk.factors.some((f) => f.code.startsWith('BATTERY'))).toBe(false);
  });
});

describe('assessRisk — warnings and levels', () => {
  it('reports MEDIUM for a single warning', () => {
    const risk = assessRisk(riskOf({ priorDrillCount: 0, priorDrillSuccessCount: 0 }));
    expect(risk.level).toBe('MEDIUM');
    expect(risk.blocked).toBe(false);
    expect(risk.factors.some((f) => f.code === 'NO_DRILL_HISTORY')).toBe(true);
  });

  it('reports HIGH once three warnings accumulate', () => {
    const risk = assessRisk(
      riskOf({
        priorDrillCount: 0,
        priorDrillSuccessCount: 0,
        envelopeConfidence: 0.25,
        forecastIntervalUnderpowered: true,
      }),
    );
    expect(risk.level).toBe('HIGH');
    expect(risk.blocked).toBe(false);
  });

  it('warns on a poor drill track record', () => {
    const risk = assessRisk(riskOf({ priorDrillCount: 4, priorDrillSuccessCount: 1 }));
    const found = risk.factors.find((f) => f.code === 'POOR_DRILL_HISTORY');
    expect(found?.facts.success_rate).toBe(0.25);
  });

  it('does not warn on a good track record', () => {
    const risk = assessRisk(riskOf({ priorDrillCount: 4, priorDrillSuccessCount: 3 }));
    expect(risk.factors.some((f) => f.code === 'POOR_DRILL_HISTORY')).toBe(false);
  });

  it('warns on an underpowered forecast interval', () => {
    const risk = assessRisk(riskOf({ forecastIntervalUnderpowered: true }));
    expect(risk.factors.some((f) => f.code === 'FORECAST_INTERVAL_UNDERPOWERED')).toBe(true);
  });

  it('warns on a low assurance grade', () => {
    const risk = assessRisk(riskOf({ envelopeConfidence: 0.25 }));
    expect(risk.factors.some((f) => f.code === 'LOW_ASSURANCE_GRADE')).toBe(true);
  });

  it('warns on incomplete telemetry without blocking', () => {
    const risk = assessRisk(riskOf({ telemetryCompleteness: 0.7 }));
    expect(risk.blocked).toBe(false);
    expect(risk.factors.some((f) => f.code === 'TELEMETRY_INCOMPLETE')).toBe(true);
  });

  it('a blocker outranks any number of warnings', () => {
    const risk = assessRisk(
      riskOf({
        emergencyStopActive: true,
        priorDrillCount: 0,
        priorDrillSuccessCount: 0,
        envelopeConfidence: 0.1,
      }),
    );
    expect(risk.level).toBe('BLOCKED');
    expect(risk.summary).toMatch(/Blocked by 1 constraint/);
  });
});

describe('assessRisk — rebound', () => {
  it('warns when recovery would outpace the ramp-down rate', () => {
    // 350 kW recovered over a 5-minute window is 70 kW/min against a 1 kW/min
    // ramp-down — a spike that can exceed the original load.
    const spiky = planReduction({
      targetReducibleKw: '350.000',
      durationMin: 30,
      mechanisms: [
        {
          ...(MECHANISMS[0] as PlanMechanismInput),
          rampKwPerMin: '1.000',
          reboundWindowMin: 5,
        },
      ],
    });
    const risk = assessRisk(riskOf({ plan: spiky }));
    expect(risk.factors.some((f) => f.code === 'REBOUND_EXCEEDS_RAMP')).toBe(true);
  });

  it('does not warn when the rebound window is generous', () => {
    const risk = assessRisk(riskOf({ plan: workloadOnlyPlan }));
    expect(risk.factors.some((f) => f.code === 'REBOUND_EXCEEDS_RAMP')).toBe(false);
  });
});

describe('assessRisk — planner decisions are surfaced', () => {
  it('promotes a slow ramp into a risk factor', () => {
    const slow = planReduction({
      targetReducibleKw: '350.000',
      durationMin: 30,
      mechanisms: [{ ...(MECHANISMS[0] as PlanMechanismInput), rampKwPerMin: '1.000' }],
      responseWindowSeconds: 600,
    });
    const risk = assessRisk(riskOf({ plan: slow }));
    expect(risk.factors.some((f) => f.code === 'RAMP_TOO_SLOW')).toBe(true);
  });

  it('promotes an unknown ramp rate into a risk factor', () => {
    const unknown = planReduction({
      targetReducibleKw: '100.000',
      durationMin: 30,
      mechanisms: [{ ...(MECHANISMS[0] as PlanMechanismInput), rampKwPerMin: null }],
    });
    const risk = assessRisk(riskOf({ plan: unknown }));
    expect(risk.factors.some((f) => f.code === 'RAMP_RATE_UNKNOWN')).toBe(true);
  });
});
