import { describe, expect, it } from 'vitest';
import {
  MAXIMUM_SAFETY_AGE_SECONDS,
  STATE_OF_CHARGE_METRIC,
  THERMAL_METRIC,
  describeSafetyProvenance,
  resolveSafetySignal,
  satisfiesSafetyGate,
  stateOfCharge,
  thermalMarginC,
  type SafetyContext,
  type SafetyReading,
} from '../src/safety/index.js';
import { simulateSafetyReadings } from '../src/safety/simulator-source.js';
import { planReduction, type PlanMechanismInput } from '../src/plan/index.js';
import { assessRisk } from '../src/risk/index.js';

const ASOF = '2026-07-21T12:00:00Z';

function readingOf(overrides: Partial<SafetyReading> = {}): SafetyReading {
  return {
    metricKey: THERMAL_METRIC,
    measuredAt: '2026-07-21T11:59:00Z',
    value: 24,
    quality: 'GOOD',
    simulated: false,
    ...overrides,
  };
}

describe('resolveSafetySignal', () => {
  it('reports MEASURED for a fresh real reading', () => {
    const signal = resolveSafetySignal({
      readings: [readingOf()],
      metricKey: THERMAL_METRIC,
      asOf: ASOF,
    });
    expect(signal.status).toBe('MEASURED');
    expect(signal.value).toBe(24);
    expect(signal.ageSeconds).toBe(60);
  });

  it('reports SIMULATED for a simulator-produced reading', () => {
    const signal = resolveSafetySignal({
      readings: [readingOf({ simulated: true })],
      metricKey: THERMAL_METRIC,
      asOf: ASOF,
    });
    expect(signal.status).toBe('SIMULATED');
    expect(signal.detail).toMatch(/SIMULATOR connector/);
  });

  it('reports STALE beyond the safety age limit', () => {
    const signal = resolveSafetySignal({
      readings: [readingOf({ measuredAt: '2026-07-21T11:50:00Z' })],
      metricKey: THERMAL_METRIC,
      asOf: ASOF,
    });
    expect(signal.status).toBe('STALE');
    expect(signal.ageSeconds).toBe(600);
  });

  it('uses a tighter age limit than general telemetry', () => {
    // A thermal margin is what stands between a plan and equipment damage.
    expect(MAXIMUM_SAFETY_AGE_SECONDS).toBeLessThan(900);
  });

  it('reports ABSENT when no reading exists', () => {
    const signal = resolveSafetySignal({ readings: [], metricKey: THERMAL_METRIC, asOf: ASOF });
    expect(signal.status).toBe('ABSENT');
    expect(signal.value).toBeNull();
  });

  it('ignores non-GOOD readings', () => {
    const signal = resolveSafetySignal({
      readings: [readingOf({ quality: 'ESTIMATED' }), readingOf({ quality: 'SUSPECT' })],
      metricKey: THERMAL_METRIC,
      asOf: ASOF,
    });
    expect(signal.status).toBe('ABSENT');
  });

  it('ignores readings for a different metric', () => {
    const signal = resolveSafetySignal({
      readings: [readingOf({ metricKey: STATE_OF_CHARGE_METRIC })],
      metricKey: THERMAL_METRIC,
      asOf: ASOF,
    });
    expect(signal.status).toBe('ABSENT');
  });

  it('selects the newest reading', () => {
    const signal = resolveSafetySignal({
      readings: [
        readingOf({ measuredAt: '2026-07-21T11:57:00Z', value: 20 }),
        readingOf({ measuredAt: '2026-07-21T11:59:30Z', value: 26 }),
        readingOf({ measuredAt: '2026-07-21T11:58:00Z', value: 22 }),
      ],
      metricKey: THERMAL_METRIC,
      asOf: ASOF,
    });
    expect(signal.value).toBe(26);
  });
});

describe('satisfiesSafetyGate — the crux', () => {
  const asOf = ASOF;
  const measured = resolveSafetySignal({ readings: [readingOf()], metricKey: THERMAL_METRIC, asOf });
  const simulated = resolveSafetySignal({
    readings: [readingOf({ simulated: true })],
    metricKey: THERMAL_METRIC,
    asOf,
  });
  const stale = resolveSafetySignal({
    readings: [readingOf({ measuredAt: '2026-07-21T11:00:00Z' })],
    metricKey: THERMAL_METRIC,
    asOf,
  });
  const absent = resolveSafetySignal({ readings: [], metricKey: THERMAL_METRIC, asOf });

  it('MEASURED satisfies the gate for a real drill', () => {
    expect(satisfiesSafetyGate(measured, false)).toBe(true);
  });

  it('SIMULATED does NOT satisfy the gate for a real drill', () => {
    // The entire point of this module: fabricated safety data must never
    // authorise a physical reduction.
    expect(satisfiesSafetyGate(simulated, false)).toBe(false);
  });

  it('SIMULATED satisfies the gate for a simulation drill', () => {
    // Nothing physical happens, so simulated inputs are appropriate.
    expect(satisfiesSafetyGate(simulated, true)).toBe(true);
  });

  it('STALE never satisfies the gate, even in simulation', () => {
    expect(satisfiesSafetyGate(stale, false)).toBe(false);
    expect(satisfiesSafetyGate(stale, true)).toBe(false);
  });

  it('ABSENT never satisfies the gate', () => {
    expect(satisfiesSafetyGate(absent, false)).toBe(false);
    expect(satisfiesSafetyGate(absent, true)).toBe(false);
  });
});

describe('derived values return null rather than an unbacked number', () => {
  function contextOf(simulated: boolean, simulationDrill: boolean): SafetyContext {
    return {
      thermal: resolveSafetySignal({
        readings: [readingOf({ simulated, value: 24 })],
        metricKey: THERMAL_METRIC,
        asOf: ASOF,
      }),
      stateOfCharge: resolveSafetySignal({
        readings: [readingOf({ metricKey: STATE_OF_CHARGE_METRIC, simulated, value: 88 })],
        metricKey: STATE_OF_CHARGE_METRIC,
        asOf: ASOF,
      }),
      simulationDrill,
    };
  }

  it('computes a thermal margin from a measured reading', () => {
    expect(thermalMarginC(contextOf(false, false), 32)).toBe(8);
  });

  it('returns null for a simulated reading on a real drill', () => {
    // A caller cannot accidentally use a simulated value as though measured;
    // the risk engine already treats null as blocking.
    expect(thermalMarginC(contextOf(true, false), 32)).toBeNull();
  });

  it('computes a margin from a simulated reading on a simulation drill', () => {
    expect(thermalMarginC(contextOf(true, true), 32)).toBe(8);
  });

  it('converts state of charge percentage to a fraction', () => {
    expect(stateOfCharge(contextOf(false, false))).toBe(0.88);
  });

  it('returns null state of charge for a simulated reading on a real drill', () => {
    expect(stateOfCharge(contextOf(true, false))).toBeNull();
  });

  it('describes provenance for the audit trail', () => {
    const lines = describeSafetyProvenance(contextOf(true, false));
    expect(lines.join(' ')).toMatch(/SIMULATED \(does not satisfy gate\)/);
  });
});

describe('simulateSafetyReadings', () => {
  const base = {
    windowStart: '2026-07-21T11:00:00Z',
    windowEnd: '2026-07-21T12:00:00Z',
    intervalSeconds: 300,
    seed: 20260721,
  };

  it('emits both canonical metrics', () => {
    const readings = simulateSafetyReadings(base);
    expect(readings.some((r) => r.metricKey === THERMAL_METRIC)).toBe(true);
    expect(readings.some((r) => r.metricKey === STATE_OF_CHARGE_METRIC)).toBe(true);
  });

  it('marks EVERY reading as simulated', () => {
    // If this ever regressed, fabricated data could clear a real safety gate.
    expect(simulateSafetyReadings(base).every((r) => r.simulated)).toBe(true);
  });

  it('is byte-identical for a given seed', () => {
    expect(simulateSafetyReadings(base)).toEqual(simulateSafetyReadings(base));
  });

  it('differs across seeds', () => {
    expect(simulateSafetyReadings(base)).not.toEqual(
      simulateSafetyReadings({ ...base, seed: 999 }),
    );
  });

  it('raises inlet temperature during a cooling reduction', () => {
    const readings = simulateSafetyReadings({
      ...base,
      coolingReductionWindows: [{ start: '2026-07-21T11:30:00Z', end: '2026-07-21T12:00:00Z' }],
    });
    const thermal = readings.filter((r) => r.metricKey === THERMAL_METRIC);
    const first = thermal[0]?.value ?? 0;
    const last = thermal[thermal.length - 1]?.value ?? 0;
    expect(last).toBeGreaterThan(first);
  });

  it('drains state of charge during a discharge window', () => {
    const readings = simulateSafetyReadings({
      ...base,
      dischargeWindows: [{ start: '2026-07-21T11:30:00Z', end: '2026-07-21T12:00:00Z' }],
    });
    const soc = readings.filter((r) => r.metricKey === STATE_OF_CHARGE_METRIC);
    expect((soc[soc.length - 1]?.value ?? 100)).toBeLessThan(soc[0]?.value ?? 0);
  });

  it('never drains state of charge below zero', () => {
    const readings = simulateSafetyReadings({
      ...base,
      windowEnd: '2026-07-21T15:00:00Z',
      dischargeWindows: [{ start: '2026-07-21T11:00:00Z', end: '2026-07-21T15:00:00Z' }],
    });
    for (const reading of readings.filter((r) => r.metricKey === STATE_OF_CHARGE_METRIC)) {
      expect(reading.value).toBeGreaterThanOrEqual(0);
    }
  });

  it('rejects an invalid window', () => {
    expect(() => simulateSafetyReadings({ ...base, windowEnd: base.windowStart })).toThrow(
      /strictly after/,
    );
  });
});

describe('risk engine consumes safety provenance', () => {
  const MECHANISMS: PlanMechanismInput[] = [
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

  const plan = planReduction({
    targetReducibleKw: '250.000',
    durationMin: 30,
    mechanisms: MECHANISMS,
  });

  function riskWith(thermalStatus: 'MEASURED' | 'SIMULATED', simulationDrill: boolean) {
    const usable = thermalStatus === 'MEASURED' || simulationDrill;
    return assessRisk({
      plan,
      envelopeConfidence: 0.85,
      envelopeStatus: 'DRAFT',
      forecastIntervalUnderpowered: false,
      telemetryAgeSeconds: 60,
      telemetryCompleteness: 1,
      thermalMarginC: usable ? 8 : null,
      batteryStateOfCharge: usable ? 0.9 : null,
      safetyProvenance: {
        thermalStatus,
        stateOfChargeStatus: thermalStatus,
        simulationDrill,
      },
      priorDrillCount: 4,
      priorDrillSuccessCount: 4,
      emergencyStopActive: false,
    });
  }

  it('permits a real drill on measured safety telemetry', () => {
    expect(riskWith('MEASURED', false).blocked).toBe(false);
  });

  it('BLOCKS a real drill on simulated safety telemetry, and says so', () => {
    const risk = riskWith('SIMULATED', false);
    expect(risk.blocked).toBe(true);
    const codes = risk.factors.map((f) => f.code);
    expect(codes).toContain('THERMAL_MARGIN_SIMULATED');
    expect(codes).toContain('BATTERY_SOC_SIMULATED');
    // The refusal distinguishes "the sensor is simulated" from "there is no
    // sensor" — different problems with different fixes.
    expect(codes).not.toContain('THERMAL_MARGIN_UNKNOWN');
  });

  it('permits a simulation drill on simulated safety telemetry', () => {
    expect(riskWith('SIMULATED', true).blocked).toBe(false);
  });

  it('still reports UNKNOWN when there is no provenance at all', () => {
    const risk = assessRisk({
      plan,
      envelopeConfidence: 0.85,
      envelopeStatus: 'DRAFT',
      forecastIntervalUnderpowered: false,
      telemetryAgeSeconds: 60,
      telemetryCompleteness: 1,
      thermalMarginC: null,
      batteryStateOfCharge: null,
      priorDrillCount: 4,
      priorDrillSuccessCount: 4,
      emergencyStopActive: false,
    });
    expect(risk.factors.map((f) => f.code)).toContain('THERMAL_MARGIN_UNKNOWN');
  });
});
