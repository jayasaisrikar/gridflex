import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISRUPTION_RANK,
  PLANNER_VERSION,
  disruptionRankOf,
  planReduction,
  type PlanMechanismInput,
} from '../src/plan/index.js';

/** The three mechanisms actually configured on the seeded facility. */
const REAL_MECHANISMS: PlanMechanismInput[] = [
  {
    id: 'm-workload',
    code: 'WORKLOAD_DEFERRAL',
    mechanismType: 'WORKLOAD',
    enabled: true,
    availableKw: '350.000',
    rampKwPerMin: '80.000',
    maximumDurationMin: 60,
    reboundWindowMin: 20,
    metadata: { provenance: 'DECLARED' },
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
    metadata: { provenance: 'DECLARED' },
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
    metadata: { provenance: 'DECLARED' },
  },
];

describe('disruption ordering', () => {
  it('draws on workload before storage before cooling', () => {
    // Deferring compute delays work. Discharging storage spends a reserve.
    // Raising setpoints moves toward a thermal limit — the only one that can
    // damage equipment, so it goes last.
    expect(DEFAULT_DISRUPTION_RANK.WORKLOAD).toBeLessThan(DEFAULT_DISRUPTION_RANK.STORAGE);
    expect(DEFAULT_DISRUPTION_RANK.STORAGE).toBeLessThan(DEFAULT_DISRUPTION_RANK.COOLING);
  });

  it('lets metadata override the default rank', () => {
    const mechanism = { ...REAL_MECHANISMS[2] as PlanMechanismInput, metadata: { disruptionRank: 0 } };
    expect(disruptionRankOf(mechanism)).toBe(0);
  });

  it('ignores a malformed rank hint rather than trusting it', () => {
    const mechanism = {
      ...REAL_MECHANISMS[2] as PlanMechanismInput,
      metadata: { disruptionRank: 'not-a-number' },
    };
    expect(disruptionRankOf(mechanism)).toBe(DEFAULT_DISRUPTION_RANK.STORAGE);
  });

  it('allocates in disruption order', () => {
    const plan = planReduction({
      targetReducibleKw: '400.000',
      durationMin: 30,
      mechanisms: REAL_MECHANISMS,
    });

    expect(plan.allocations[0]?.code).toBe('WORKLOAD_DEFERRAL');
    expect(plan.allocations[0]?.allocatedKw).toBe('350.000');
    expect(plan.allocations[1]?.code).toBe('UPS_BESS');
    expect(plan.allocations[1]?.allocatedKw).toBe('50.000');
    // Cooling untouched — the target was met before reaching it.
    expect(plan.allocations).toHaveLength(2);
  });
});

describe('planReduction — duration eligibility (real constraint)', () => {
  it('excludes mechanisms that cannot sustain the full window', () => {
    // The real facility: cooling and storage cap at 30 min, workload at 60.
    // A 60-minute drill can therefore only draw 350 kW of the nominal 600.
    const plan = planReduction({
      targetReducibleKw: '600.000',
      durationMin: 60,
      mechanisms: REAL_MECHANISMS,
    });

    expect(plan.allocations).toHaveLength(1);
    expect(plan.allocations[0]?.code).toBe('WORKLOAD_DEFERRAL');
    expect(plan.allocatedKw).toBe('350.000');
    expect(plan.shortfallKw).toBe('250.000');
    expect(plan.feasible).toBe(false);

    const codes = plan.excluded.map((e) => e.code).sort();
    expect(codes).toEqual(['COOLING_HEADROOM', 'UPS_BESS']);
    expect(plan.excluded.every((e) => e.reasonCode === 'DURATION_EXCEEDS_MECHANISM_LIMIT')).toBe(true);
  });

  it('records the capacity forgone to the duration limit', () => {
    const plan = planReduction({
      targetReducibleKw: '600.000',
      durationMin: 60,
      mechanisms: REAL_MECHANISMS,
    });
    const decision = plan.decisions.find(
      (d) => d.decisionCode === 'DURATION_EXCEEDS_MECHANISM_LIMIT' && d.facts.mechanism === 'UPS_BESS',
    );
    expect(decision?.facts.forgone_kw).toBe('150.000');
  });

  it('admits a mechanism whose limit exactly equals the duration', () => {
    const plan = planReduction({
      targetReducibleKw: '600.000',
      durationMin: 30,
      mechanisms: REAL_MECHANISMS,
    });
    expect(plan.excluded).toHaveLength(0);
    expect(plan.allocatedKw).toBe('600.000');
    expect(plan.feasible).toBe(true);
  });

  it('treats a null duration limit as unbounded', () => {
    const plan = planReduction({
      targetReducibleKw: '100.000',
      durationMin: 999,
      mechanisms: [{ ...(REAL_MECHANISMS[0] as PlanMechanismInput), maximumDurationMin: null }],
    });
    expect(plan.feasible).toBe(true);
  });
});

describe('planReduction — allocation arithmetic', () => {
  it('never allocates beyond a mechanism cap', () => {
    const plan = planReduction({
      targetReducibleKw: '5000.000',
      durationMin: 30,
      mechanisms: REAL_MECHANISMS,
    });
    for (const allocation of plan.allocations) {
      const mechanism = REAL_MECHANISMS.find((m) => m.code === allocation.code);
      expect(Number(allocation.allocatedKw)).toBeLessThanOrEqual(Number(mechanism?.availableKw));
    }
  });

  it('allocations sum exactly to the reported total', () => {
    const plan = planReduction({
      targetReducibleKw: '475.500',
      durationMin: 30,
      mechanisms: REAL_MECHANISMS,
    });
    const sum = plan.allocations.reduce((acc, a) => acc + a.allocatedMkw, 0n);
    expect(sum).toBe(plan.allocatedMkw);
    expect(plan.allocatedKw).toBe('475.500');
  });

  it('preserves sub-kW precision', () => {
    const plan = planReduction({
      targetReducibleKw: '350.001',
      durationMin: 30,
      mechanisms: REAL_MECHANISMS,
    });
    expect(plan.allocations[1]?.allocatedKw).toBe('0.001');
    expect(plan.allocatedKw).toBe('350.001');
  });

  it('reports a shortfall rather than over-allocating', () => {
    const plan = planReduction({
      targetReducibleKw: '900.000',
      durationMin: 30,
      mechanisms: REAL_MECHANISMS,
    });
    expect(plan.allocatedKw).toBe('600.000');
    expect(plan.shortfallKw).toBe('300.000');
    expect(plan.feasible).toBe(false);
    expect(plan.decisions.some((d) => d.decisionCode === 'PLAN_SHORTFALL')).toBe(true);
  });

  it('stops allocating once the target is met', () => {
    const plan = planReduction({
      targetReducibleKw: '100.000',
      durationMin: 30,
      mechanisms: REAL_MECHANISMS,
    });
    expect(plan.allocations).toHaveLength(1);
    expect(plan.allocatedKw).toBe('100.000');
  });

  it('is deterministic across repeated calls', () => {
    const request = {
      targetReducibleKw: '400.000',
      durationMin: 30,
      mechanisms: REAL_MECHANISMS,
    };
    const first = planReduction(request);
    for (let i = 0; i < 5; i += 1) expect(planReduction(request)).toEqual(first);
  });

  it('breaks rank ties deterministically by code', () => {
    const tied: PlanMechanismInput[] = [
      { ...(REAL_MECHANISMS[0] as PlanMechanismInput), id: 'b', code: 'BBB' },
      { ...(REAL_MECHANISMS[0] as PlanMechanismInput), id: 'a', code: 'AAA' },
    ];
    expect(planReduction({ targetReducibleKw: '10.000', durationMin: 30, mechanisms: tied }).allocations[0]?.code).toBe('AAA');
  });
});

describe('planReduction — exclusions', () => {
  it('excludes disabled mechanisms', () => {
    const plan = planReduction({
      targetReducibleKw: '100.000',
      durationMin: 30,
      mechanisms: [{ ...(REAL_MECHANISMS[0] as PlanMechanismInput), enabled: false }],
    });
    expect(plan.excluded[0]?.reasonCode).toBe('MECHANISM_DISABLED');
    expect(plan.feasible).toBe(false);
  });

  it('excludes mechanisms with no available capacity', () => {
    const plan = planReduction({
      targetReducibleKw: '100.000',
      durationMin: 30,
      mechanisms: [{ ...(REAL_MECHANISMS[0] as PlanMechanismInput), availableKw: '0.000' }],
    });
    expect(plan.excluded[0]?.reasonCode).toBe('NO_AVAILABLE_CAPACITY');
  });

  it('is infeasible with no mechanisms at all', () => {
    const plan = planReduction({ targetReducibleKw: '100.000', durationMin: 30, mechanisms: [] });
    expect(plan.feasible).toBe(false);
    expect(plan.allocatedKw).toBe('0.000');
  });
});

describe('planReduction — ramp and rebound', () => {
  it('computes response time from the aggregate ramp', () => {
    // 400 kW at 80+150 = 230 kW/min => 1.739 min => 105s (ceiling).
    const plan = planReduction({
      targetReducibleKw: '400.000',
      durationMin: 30,
      mechanisms: REAL_MECHANISMS,
    });
    expect(plan.aggregateRampKwPerMin).toBe('230.000');
    expect(plan.estimatedResponseSeconds).toBe(105);
  });

  it('warns when the ramp cannot meet the response window', () => {
    const slow: PlanMechanismInput[] = [
      { ...(REAL_MECHANISMS[0] as PlanMechanismInput), rampKwPerMin: '1.000' },
    ];
    const plan = planReduction({
      targetReducibleKw: '350.000',
      durationMin: 30,
      mechanisms: slow,
      responseWindowSeconds: 600,
    });
    expect(plan.estimatedResponseSeconds).toBe(21_000);
    expect(plan.decisions.some((d) => d.decisionCode === 'RAMP_TOO_SLOW_FOR_RESPONSE_WINDOW')).toBe(true);
  });

  it('reports unknown rather than instant when no ramp is declared', () => {
    // Zero declared ramp must not read as "reaches target immediately".
    const plan = planReduction({
      targetReducibleKw: '100.000',
      durationMin: 30,
      mechanisms: [{ ...(REAL_MECHANISMS[0] as PlanMechanismInput), rampKwPerMin: null }],
    });
    expect(plan.estimatedResponseSeconds).toBe(0);
    expect(plan.decisions.some((d) => d.decisionCode === 'RAMP_RATE_UNKNOWN')).toBe(true);
  });

  it('reports the widest rebound window among allocated mechanisms', () => {
    const plan = planReduction({
      targetReducibleKw: '400.000',
      durationMin: 30,
      mechanisms: REAL_MECHANISMS,
    });
    // Workload 20 min, storage 45 min => watch for 45.
    expect(plan.reboundWindowMin).toBe(45);
  });

  it('ignores rebound windows of mechanisms that were not used', () => {
    const plan = planReduction({
      targetReducibleKw: '100.000',
      durationMin: 30,
      mechanisms: REAL_MECHANISMS,
    });
    expect(plan.reboundWindowMin).toBe(20);
  });
});

describe('planReduction — input validation', () => {
  it('rejects a non-positive duration', () => {
    expect(() =>
      planReduction({ targetReducibleKw: '100.000', durationMin: 0, mechanisms: REAL_MECHANISMS }),
    ).toThrow(/positive integer/);
  });

  it('rejects a negative target', () => {
    expect(() =>
      planReduction({ targetReducibleKw: '-1.000', durationMin: 30, mechanisms: REAL_MECHANISMS }),
    ).toThrow(/may not be negative/);
  });

  it('handles a zero target as trivially feasible with no allocations', () => {
    const plan = planReduction({
      targetReducibleKw: '0.000',
      durationMin: 30,
      mechanisms: REAL_MECHANISMS,
    });
    expect(plan.allocations).toHaveLength(0);
    expect(plan.allocatedKw).toBe('0.000');
    expect(plan.plannerVersion).toBe(PLANNER_VERSION);
  });
});
