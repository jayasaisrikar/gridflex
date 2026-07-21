import { describe, expect, it } from 'vitest';
import { buildFeatureFrame, formatUtcInstant, parseUtcInstant, type RawReading } from '../src/features/index.js';
import {
  MODIFIED_Z_THRESHOLD,
  STUCK_METER_MIN_REPEATS,
  confidencePenalty,
  detectDrillAnomalies,
  detectTelemetryAnomalies,
  medianAbsoluteDeviation,
  modifiedZScore,
} from '../src/anomaly/index.js';

const START = '2026-03-02T00:00:00Z';
const INTERVAL_SECONDS = 300;

function frameOf(loads: readonly (number | null)[]) {
  const startMs = parseUtcInstant(START);
  const readings: RawReading[] = [];
  loads.forEach((load, index) => {
    if (load === null) return;
    readings.push({
      measuredAt: formatUtcInstant(startMs + index * INTERVAL_SECONDS * 1000),
      valueKw: load,
      quality: 'GOOD',
    });
  });
  return buildFeatureFrame({
    readings,
    windowStart: START,
    windowEnd: formatUtcInstant(startMs + loads.length * INTERVAL_SECONDS * 1000),
    intervalSeconds: INTERVAL_SECONDS,
  });
}

describe('medianAbsoluteDeviation', () => {
  it('computes median and MAD exactly', () => {
    const stats = medianAbsoluteDeviation([1000n, 2000n, 3000n, 4000n, 5000n]);
    expect(stats.median).toBe(3000n);
    // Deviations 2000,1000,0,1000,2000 => median 1000.
    expect(stats.mad).toBe(1000n);
  });

  it('is UNMOVED by an extreme outlier, unlike a standard deviation', () => {
    // The point of MAD: a single 100x spike must not inflate the scale estimate
    // and thereby hide the next spike.
    const clean = medianAbsoluteDeviation([1000n, 1000n, 1000n, 1000n, 1000n]);
    const withSpike = medianAbsoluteDeviation([1000n, 1000n, 1000n, 1000n, 100_000n]);
    expect(withSpike.median).toBe(clean.median);
    expect(withSpike.mad).toBe(clean.mad);
  });

  it('rejects an empty series', () => {
    expect(() => medianAbsoluteDeviation([])).toThrow(/empty series/);
  });
});

describe('modifiedZScore', () => {
  it('is zero at the median', () => {
    expect(modifiedZScore(3000n, { median: 3000n, mad: 500n })).toBe(0);
  });

  it('returns 0 for a perfectly constant series rather than infinity', () => {
    // MAD of zero has no scale; dividing by it would report every deviation as
    // infinitely anomalous and fire on every interval.
    expect(modifiedZScore(9999n, { median: 1000n, mad: 0n })).toBe(0);
  });

  it('is signed', () => {
    const stats = { median: 1000n, mad: 100n };
    expect(modifiedZScore(2000n, stats)).toBeGreaterThan(0);
    expect(modifiedZScore(0n, stats)).toBeLessThan(0);
  });

  it('matches the Iglewicz-Hoaglin definition', () => {
    // 0.6745 * (2000 - 1000) / 100 = 6.745
    expect(modifiedZScore(2000n, { median: 1000n, mad: 100n })).toBeCloseTo(6.745, 3);
  });
});

describe('detectTelemetryAnomalies', () => {
  it('reports nothing on a clean, varied series', () => {
    const loads = Array.from({ length: 48 }, (_, i) => 1500 + (i % 7) * 10);
    expect(detectTelemetryAnomalies({ frame: frameOf(loads) })).toHaveLength(0);
  });

  it('flags a load spike', () => {
    const loads = Array.from({ length: 48 }, (_, i) => 1500 + (i % 7) * 10);
    loads[20] = 9000;
    const anomalies = detectTelemetryAnomalies({ frame: frameOf(loads) });
    const spike = anomalies.find((a) => a.code === 'LOAD_SPIKE');
    expect(spike).toBeDefined();
    expect(spike?.severity).toBe('CRITICAL');
  });

  it('flags a load drop distinctly from a spike', () => {
    const loads = Array.from({ length: 48 }, (_, i) => 1500 + (i % 7) * 10);
    loads[20] = 5;
    const anomalies = detectTelemetryAnomalies({ frame: frameOf(loads) });
    expect(anomalies.some((a) => a.code === 'LOAD_DROP')).toBe(true);
    expect(anomalies.some((a) => a.code === 'LOAD_SPIKE')).toBe(false);
  });

  it('reports the instant an anomaly occurred', () => {
    const loads = Array.from({ length: 48 }, (_, i) => 1500 + (i % 7) * 10);
    loads[20] = 9000;
    const spike = detectTelemetryAnomalies({ frame: frameOf(loads) }).find(
      (a) => a.code === 'LOAD_SPIKE',
    );
    expect(spike?.at).toBe(formatUtcInstant(parseUtcInstant(START) + 20 * INTERVAL_SECONDS * 1000));
  });

  it('does NOT fire on normal diurnal variation', () => {
    // A smooth 1000..2000 ramp is ordinary behaviour, not an anomaly.
    const loads = Array.from({ length: 48 }, (_, i) => 1000 + i * 20);
    const anomalies = detectTelemetryAnomalies({ frame: frameOf(loads) });
    expect(anomalies.filter((a) => a.code === 'LOAD_SPIKE' || a.code === 'LOAD_DROP')).toHaveLength(0);
  });

  it('detects a stuck meter', () => {
    // A stuck meter reports a plausible value forever — it passes every range
    // check and quality flag, which is why it needs its own detector.
    const loads = Array.from({ length: 48 }, (_, i) =>
      i >= 10 && i < 10 + STUCK_METER_MIN_REPEATS + 2 ? 1500 : 1500 + (i % 7) * 10,
    );
    const anomalies = detectTelemetryAnomalies({ frame: frameOf(loads) });
    expect(anomalies.some((a) => a.code === 'METER_STUCK')).toBe(true);
  });

  it('does not call a brief plateau a stuck meter', () => {
    const loads = Array.from({ length: 48 }, (_, i) => (i >= 10 && i < 14 ? 1500 : 1500 + (i % 7) * 10));
    expect(detectTelemetryAnomalies({ frame: frameOf(loads) }).some((a) => a.code === 'METER_STUCK')).toBe(
      false,
    );
  });

  it('flags a completeness drop', () => {
    const loads: (number | null)[] = Array.from({ length: 48 }, (_, i) =>
      i % 3 === 0 ? null : 1500 + (i % 7) * 10,
    );
    const anomalies = detectTelemetryAnomalies({ frame: frameOf(loads) });
    const drop = anomalies.find((a) => a.code === 'TELEMETRY_COMPLETENESS_DROP');
    expect(drop).toBeDefined();
    expect(drop?.severity).toBe('WARNING');
  });

  it('escalates a severe completeness drop to CRITICAL', () => {
    const loads: (number | null)[] = Array.from({ length: 48 }, (_, i) =>
      i % 4 === 0 ? 1500 : null,
    );
    const drop = detectTelemetryAnomalies({ frame: frameOf(loads) }).find(
      (a) => a.code === 'TELEMETRY_COMPLETENESS_DROP',
    );
    expect(drop?.severity).toBe('CRITICAL');
  });

  it('reports NO_TELEMETRY for an empty frame rather than throwing', () => {
    const anomalies = detectTelemetryAnomalies({ frame: frameOf(Array(48).fill(null)) });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.code).toBe('NO_TELEMETRY');
    expect(anomalies[0]?.severity).toBe('CRITICAL');
  });

  it('is deterministic', () => {
    const loads = Array.from({ length: 48 }, (_, i) => 1500 + (i % 7) * 10);
    loads[20] = 9000;
    const frame = frameOf(loads);
    const first = detectTelemetryAnomalies({ frame });
    for (let i = 0; i < 3; i += 1) expect(detectTelemetryAnomalies({ frame })).toEqual(first);
  });

  it('uses the documented threshold', () => {
    expect(MODIFIED_Z_THRESHOLD).toBe(3.5);
  });
});

describe('detectDrillAnomalies', () => {
  const base = {
    committedReductionMkw: 500_000n,
    deliveredReducibleMkw: 500_000n,
    deliveredReductionMkw: 500_000n,
    baselineMkw: 1_600_000n,
    peakReboundMkw: null,
    coolingDuringMkw: null,
    coolingBaselineMkw: null,
  };

  it('reports nothing when a drill delivered as committed', () => {
    expect(detectDrillAnomalies(base)).toHaveLength(0);
  });

  it('flags a delivery shortfall', () => {
    const anomalies = detectDrillAnomalies({ ...base, deliveredReductionMkw: 400_000n });
    const shortfall = anomalies.find((a) => a.code === 'DELIVERY_SHORTFALL');
    expect(shortfall).toBeDefined();
    expect(shortfall?.facts.delivered_fraction).toBe(0.8);
  });

  it('escalates a severe shortfall to CRITICAL', () => {
    const anomalies = detectDrillAnomalies({ ...base, deliveredReductionMkw: 100_000n });
    expect(anomalies.find((a) => a.code === 'DELIVERY_SHORTFALL')?.severity).toBe('CRITICAL');
  });

  it('does not flag a drill that slightly over-delivered', () => {
    expect(detectDrillAnomalies({ ...base, deliveredReductionMkw: 550_000n })).toHaveLength(0);
  });

  it('flags a rebound spike above the pre-drill baseline', () => {
    // A grid problem even when the drill itself delivered perfectly.
    const anomalies = detectDrillAnomalies({ ...base, peakReboundMkw: 2_100_000n });
    expect(anomalies.some((a) => a.code === 'REBOUND_SPIKE')).toBe(true);
  });

  it('does not flag a rebound that returns to baseline', () => {
    expect(detectDrillAnomalies({ ...base, peakReboundMkw: 1_620_000n })).toHaveLength(0);
  });

  it('flags elevated cooling during a reduction', () => {
    // Cooling rising during a reduction suggests heat was moved rather than
    // energy saved.
    const anomalies = detectDrillAnomalies({
      ...base,
      coolingDuringMkw: 240_000n,
      coolingBaselineMkw: 200_000n,
    });
    const cooling = anomalies.find((a) => a.code === 'COOLING_CONSUMPTION_ELEVATED');
    expect(cooling).toBeDefined();
    expect(cooling?.facts.ratio).toBe(1.2);
  });

  it('does not flag cooling within normal variation', () => {
    expect(
      detectDrillAnomalies({ ...base, coolingDuringMkw: 205_000n, coolingBaselineMkw: 200_000n }),
    ).toHaveLength(0);
  });

  it('reports several independent anomalies together', () => {
    const anomalies = detectDrillAnomalies({
      ...base,
      deliveredReductionMkw: 200_000n,
      peakReboundMkw: 2_400_000n,
      coolingDuringMkw: 260_000n,
      coolingBaselineMkw: 200_000n,
    });
    const codes = anomalies.map((a) => a.code);
    expect(codes).toContain('DELIVERY_SHORTFALL');
    expect(codes).toContain('REBOUND_SPIKE');
    expect(codes).toContain('COOLING_CONSUMPTION_ELEVATED');
  });

  it('handles a zero commitment without dividing by zero', () => {
    const anomalies = detectDrillAnomalies({ ...base, committedReductionMkw: 0n });
    expect(anomalies.some((a) => a.code === 'DELIVERY_SHORTFALL')).toBe(false);
  });
});

describe('confidencePenalty', () => {
  it('is zero with no anomalies', () => {
    expect(confidencePenalty([])).toBe(0);
  });

  it('weights CRITICAL above WARNING', () => {
    const critical = confidencePenalty([
      { code: 'X', severity: 'CRITICAL', detail: '', at: null, facts: {} },
    ]);
    const warning = confidencePenalty([
      { code: 'X', severity: 'WARNING', detail: '', at: null, facts: {} },
    ]);
    expect(critical).toBeGreaterThan(warning);
  });

  it('ignores INFO', () => {
    expect(confidencePenalty([{ code: 'X', severity: 'INFO', detail: '', at: null, facts: {} }])).toBe(0);
  });

  it('never exceeds 1', () => {
    const many = Array.from({ length: 20 }, () => ({
      code: 'X',
      severity: 'CRITICAL' as const,
      detail: '',
      at: null,
      facts: {},
    }));
    expect(confidencePenalty(many)).toBe(1);
  });
});

describe('detectTelemetryAnomalies — drill awareness (found against real telemetry)', () => {
  // The facility's completed drill (11:25-11:55, ~490 kW reduction) was reported
  // as five CRITICAL anomalies with a maximum confidence penalty. A detector
  // that fires whenever the product succeeds gets muted, and a muted detector
  // catches nothing.
  // Real telemetry jitters; a perfectly flat series has MAD 0 and no scale.
  const loads = Array.from({ length: 48 }, (_, i) =>
    i >= 30 && i < 36 ? 1110 + (i % 3) : 1600 + (i % 5),
  );
  const frame = frameOf(loads);
  const drillStart = formatUtcInstant(parseUtcInstant(START) + 30 * INTERVAL_SECONDS * 1000);
  const drillEnd = formatUtcInstant(parseUtcInstant(START) + 36 * INTERVAL_SECONDS * 1000);

  it('flags a planned reduction as CRITICAL when it does not know about the drill', () => {
    const anomalies = detectTelemetryAnomalies({ frame });
    expect(anomalies.filter((a) => a.code === 'LOAD_DROP').length).toBeGreaterThan(0);
    expect(confidencePenalty(anomalies)).toBeGreaterThan(0.5);
  });

  it('reports NOTHING for the same data once the drill window is known', () => {
    const anomalies = detectTelemetryAnomalies({
      frame,
      knownReductionWindows: [{ start: drillStart, end: drillEnd, drillId: 'd1' }],
    });
    expect(anomalies).toHaveLength(0);
    expect(confidencePenalty(anomalies)).toBe(0);
  });

  it('still detects a genuine anomaly OUTSIDE the drill window', () => {
    // Excluding drills must not blind the detector to real faults nearby.
    const withSpike = [...loads];
    withSpike[10] = 9000;
    const anomalies = detectTelemetryAnomalies({
      frame: frameOf(withSpike),
      knownReductionWindows: [{ start: drillStart, end: drillEnd, drillId: 'd1' }],
    });
    expect(anomalies.some((a) => a.code === 'LOAD_SPIKE')).toBe(true);
  });

  it('treats the drill window end as exclusive', () => {
    // A window ending one interval early would leave that interval firing.
    const shortWindow = formatUtcInstant(parseUtcInstant(START) + 35 * INTERVAL_SECONDS * 1000);
    const anomalies = detectTelemetryAnomalies({
      frame,
      knownReductionWindows: [{ start: drillStart, end: shortWindow }],
    });
    expect(anomalies.some((a) => a.code === 'LOAD_DROP')).toBe(true);
  });

  it('reports NO_BASELINE_OUTSIDE_DRILLS when every reading is inside a drill', () => {
    const anomalies = detectTelemetryAnomalies({
      frame,
      knownReductionWindows: [{ start: START, end: formatUtcInstant(parseUtcInstant(START) + 48 * INTERVAL_SECONDS * 1000) }],
    });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.code).toBe('NO_BASELINE_OUTSIDE_DRILLS');
    expect(anomalies[0]?.severity).toBe('INFO');
  });

  it('excludes drill intervals from the MAD baseline', () => {
    // A drill left in the sample inflates MAD and masks genuine outliers.
    const withDrill = detectTelemetryAnomalies({ frame });
    const withoutDrill = detectTelemetryAnomalies({
      frame,
      knownReductionWindows: [{ start: drillStart, end: drillEnd }],
    });
    expect(withDrill.length).toBeGreaterThan(withoutDrill.length);
  });
});
