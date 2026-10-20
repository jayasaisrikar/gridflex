import { describe, expect, it } from 'vitest';
import {
  GRID_SIGNALS_FIXTURE_VERSION,
  PEAK_WINDOW,
  readGridSignals,
} from '../src/signals/index.js';
import {
  COOLING_FIRST_RANK,
  DEFAULT_DISRUPTION_RANK,
  disruptionRankOf,
  planReduction,
  type PlanMechanismInput,
} from '../src/plan/index.js';

const NOON_UTC = '2026-08-15T08:00:00Z'; // 12:00 Dubai (UTC+4) — window opens.

function snapshotAt(at: string, hourLocal: number) {
  return readGridSignals({
    at,
    timezone: 'Asia/Dubai',
    hourLocal,
    dateLocal: at.slice(0, 10),
  });
}

describe('READ_GRID_SIGNALS fixture', () => {
  it('flags the DEWA peak window and remaining minutes at its open', () => {
    const snapshot = snapshotAt(NOON_UTC, 12);
    expect(snapshot.peak.isPeakNow).toBe(true);
    expect(snapshot.peak.minutesRemaining).toBe(300);
    expect(snapshot.peak.minutesToPeak).toBeNull();
    expect(snapshot.peak.startHourLocal).toBe(PEAK_WINDOW.startHourLocal);
  });

  it('reports minutes to peak before the window', () => {
    const snapshot = snapshotAt(NOON_UTC, 9);
    expect(snapshot.peak.isPeakNow).toBe(false);
    expect(snapshot.peak.minutesToPeak).toBe(180);
  });

  it('reports neither state after the window closes', () => {
    const snapshot = snapshotAt(NOON_UTC, 18);
    expect(snapshot.peak.isPeakNow).toBe(false);
    expect(snapshot.peak.minutesToPeak).toBeNull();
    expect(snapshot.peak.minutesRemaining).toBeNull();
  });

  it('is deterministic for the same wall clock', () => {
    const a = snapshotAt(NOON_UTC, 12);
    const b = snapshotAt(NOON_UTC, 12);
    expect(a).toEqual(b);
  });

  it('carries a 24-hour temperature forecast with the 46 C demo maximum', () => {
    const snapshot = snapshotAt(NOON_UTC, 12);
    expect(snapshot.temperatureForecast).toHaveLength(24);
    const hottest = Math.max(...snapshot.temperatureForecast.map((p) => p.temperatureC));
    expect(hottest).toBe(46);
  });

  it('labels every point as simulated fixture data', () => {
    const snapshot = snapshotAt(NOON_UTC, 12);
    expect(snapshot.simulated).toBe(true);
    expect(snapshot.label).toBe('SIMULATED');
    expect(snapshot.source).toBe('FIXTURE');
    expect(snapshot.fixtureVersion).toBe(GRID_SIGNALS_FIXTURE_VERSION);
    expect(
      snapshot.carbonIntensity.every((point) => point.kgCo2ePerKwh > 0 && point.source.length > 0),
    ).toBe(true);
  });
});

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
    code: 'COOLING_SETPOINT_SHIFT',
    mechanismType: 'COOLING',
    enabled: true,
    availableKw: '400.000',
    rampKwPerMin: '40.000',
    maximumDurationMin: 60,
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

describe('cooling-first plan priority', () => {
  it('keeps the disruption-first default order untouched', () => {
    expect(DEFAULT_DISRUPTION_RANK.COOLING).toBeGreaterThan(DEFAULT_DISRUPTION_RANK.WORKLOAD);
    const plan = planReduction({ targetReducibleKw: '500.000', durationMin: 30, mechanisms: MECHANISMS });
    expect(plan.allocations[0]?.code).toBe('WORKLOAD_DEFERRAL');
  });

  it('draws cooling first and records the priority decision', () => {
    const plan = planReduction({
      targetReducibleKw: '500.000',
      durationMin: 30,
      mechanisms: MECHANISMS,
      priority: 'COOLING_FIRST',
    });
    expect(plan.allocations.map((a) => a.code)).toEqual([
      'COOLING_SETPOINT_SHIFT',
      'UPS_BESS',
    ]);
    expect(plan.feasible).toBe(true);
    expect(plan.shortfallKw).toBe('0.000');
    expect(
      plan.decisions.some(
        (d) => d.decisionType === 'PLAN_PRIORITY' && d.decisionCode === 'COOLING_FIRST_PRIORITY',
      ),
    ).toBe(true);
  });

  it('respects per-mechanism metadata override under cooling-first', () => {
    const withOverride: PlanMechanismInput[] = MECHANISMS.map((m) =>
      m.code === 'WORKLOAD_DEFERRAL' ? { ...m, metadata: { disruptionRank: 0 } } : m,
    );
    expect(disruptionRankOf(withOverride[0]!, 'COOLING_FIRST')).toBe(0);
    expect(COOLING_FIRST_RANK.COOLING).toBe(1);
  });

  it('still meets the target when cooling is drawn down first', () => {
    const plan = planReduction({
      targetReducibleKw: '800.000',
      durationMin: 30,
      mechanisms: MECHANISMS,
      priority: 'COOLING_FIRST',
    });
    expect(plan.allocatedKw).toBe('800.000');
    expect(plan.shortfallKw).toBe('0.000');
  });
});
