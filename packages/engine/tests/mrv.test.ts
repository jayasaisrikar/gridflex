import { describe, expect, it } from 'vitest';
import {
  computeBaseline,
  computeMrv,
  MrvInsufficientDataError,
  type IntervalSample,
} from '../src/mrv/index.js';
import { kwNumberToMilliKw } from '../src/units.js';

const kw = kwNumberToMilliKw;

function samples(values: readonly (number | null)[]): IntervalSample[] {
  return values.map((value, index) => ({
    measuredAt: `2026-07-21T12:${String(index).padStart(2, '0')}:00Z`,
    power: value === null ? null : kw(value),
  }));
}

function flatDay(date: string, value: number, count: number) {
  return { date, samples: samples(Array.from({ length: count }, () => value)) };
}

describe('computeBaseline', () => {
  it('takes the median of the same relative interval across eligible days', () => {
    const result = computeBaseline({
      eligibleDays: [
        { date: '2026-07-20', samples: samples([1000, 2000]) },
        { date: '2026-07-19', samples: samples([1600, 1600]) },
        { date: '2026-07-18', samples: samples([1500, 1500]) },
      ],
      precedingNonEventSamples: [],
      intervalCount: 2,
    });

    expect(result.method).toBe('MEDIAN_SAME_INTERVAL_5_DAYS');
    // medians of [1000,1600,1500] and [2000,1600,1500]
    expect(result.series).toEqual([kw(1500), kw(1600)]);
    expect(result.eligibleDaysUsed).toHaveLength(3);
  });

  it('uses at most five eligible days', () => {
    const days = Array.from({ length: 8 }, (_, i) => flatDay(`2026-07-${20 - i}`, 1600, 1));
    const result = computeBaseline({
      eligibleDays: days,
      precedingNonEventSamples: [],
      intervalCount: 1,
    });
    expect(result.eligibleDaysUsed).toHaveLength(5);
  });

  it('falls back to the last 12 non-event intervals when no day is usable', () => {
    const result = computeBaseline({
      eligibleDays: [],
      precedingNonEventSamples: samples(Array.from({ length: 20 }, () => 1550)),
      intervalCount: 3,
    });

    expect(result.method).toBe('MEDIAN_LAST_12_NON_EVENT_INTERVALS');
    expect(result.series).toEqual([kw(1550), kw(1550), kw(1550)]);
    expect(result.eligibleDaysUsed).toEqual([]);
  });

  it('excludes intervals with no history instead of inventing a baseline', () => {
    const result = computeBaseline({
      eligibleDays: [{ date: '2026-07-20', samples: samples([1600, null]) }],
      precedingNonEventSamples: [],
      intervalCount: 2,
    });
    expect(result.excludedIntervalIndexes).toEqual([1]);
  });

  it('throws when there is no usable history at all', () => {
    expect(() =>
      computeBaseline({ eligibleDays: [], precedingNonEventSamples: [], intervalCount: 1 }),
    ).toThrow(MrvInsufficientDataError);
  });
});

describe('computeMrv', () => {
  const thirtyIntervalsAt = (value: number | null) =>
    samples(Array.from({ length: 30 }, () => value));

  const baselineOf = (value: number) =>
    computeBaseline({
      eligibleDays: [flatDay('2026-07-20', value, 30)],
      precedingNonEventSamples: [],
      intervalCount: 30,
    });

  it('computes delivered energy and performance for an exact scenario', () => {
    // Baseline 1600 kW, actual 1100 kW => 500 kW reduction held for 30 minutes.
    const result = computeMrv({
      baseline: baselineOf(1600),
      actual: thirtyIntervalsAt(1100),
      intervalSeconds: 60,
      committedEnergyWh: 250_000n,
    });

    expect(result.deliveredEnergyWh).toBe(250_000n); // exactly 250 kWh
    expect(result.performanceBps).toBe(10_000);
    expect(result.averageDeliveredKw).toBe('500.000');
    expect(result.telemetryCompleteness).toBe(1);
  });

  it('never returns negative delivery when load exceeds baseline', () => {
    const result = computeMrv({
      baseline: baselineOf(1600),
      actual: thirtyIntervalsAt(1800), // consuming MORE than baseline
      intervalSeconds: 60,
      committedEnergyWh: 250_000n,
    });
    expect(result.deliveredEnergyWh).toBe(0n);
    expect(result.performanceBps).toBe(0);
  });

  it('treats missing intervals as zero delivery and records them', () => {
    const actual = thirtyIntervalsAt(1100);
    actual[5] = { measuredAt: actual[5]!.measuredAt, power: null };
    actual[6] = { measuredAt: actual[6]!.measuredAt, power: null };

    const result = computeMrv({
      baseline: baselineOf(1600),
      actual,
      intervalSeconds: 60,
      committedEnergyWh: 250_000n,
    });

    // 28 of 30 intervals delivered 500 kW for 60 s.
    expect(result.deliveredEnergyWh).toBeLessThan(250_000n);
    expect(result.maximumGapIntervals).toBe(2);
    expect(result.telemetryCompleteness).toBeCloseTo(28 / 30, 10);
    expect(result.qualityBlocks.filter((b) => b.code === 'MISSING_INTERVAL')).toHaveLength(2);
  });

  it('tracks the longest consecutive gap, not the total gap count', () => {
    const actual = thirtyIntervalsAt(1100);
    for (const index of [2, 10, 11, 12]) {
      actual[index] = { measuredAt: actual[index]!.measuredAt, power: null };
    }
    const result = computeMrv({
      baseline: baselineOf(1600),
      actual,
      intervalSeconds: 60,
      committedEnergyWh: 250_000n,
    });
    expect(result.maximumGapIntervals).toBe(3);
  });

  it('reports rebound separately without subtracting it from delivery', () => {
    const result = computeMrv({
      baseline: baselineOf(1600),
      actual: thirtyIntervalsAt(1100),
      intervalSeconds: 60,
      committedEnergyWh: 250_000n,
      // 10 intervals at 1900 kW = 300 kW above the 1600 kW reference.
      reboundSamples: samples(Array.from({ length: 10 }, () => 1900)),
    });

    expect(result.deliveredEnergyWh).toBe(250_000n); // unchanged by rebound
    expect(result.reboundEnergyWh).toBe(50_000n); // 300 kW x 10 min = 50 kWh
  });

  it('caps performance at 10000 bps when over-delivering', () => {
    const result = computeMrv({
      baseline: baselineOf(1600),
      actual: thirtyIntervalsAt(900),
      intervalSeconds: 60,
      committedEnergyWh: 250_000n,
    });
    expect(result.performanceBps).toBe(10_000);
  });

  it('rejects misaligned baseline and actual series', () => {
    expect(() =>
      computeMrv({
        baseline: baselineOf(1600),
        actual: samples([1100]),
        intervalSeconds: 60,
        committedEnergyWh: 250_000n,
      }),
    ).toThrow(/align interval-for-interval/);
  });

  it('records the methodology version on every result', () => {
    const result = computeMrv({
      baseline: baselineOf(1600),
      actual: thirtyIntervalsAt(1100),
      intervalSeconds: 60,
      committedEnergyWh: 250_000n,
    });
    expect(result.methodologyVersion).toBe('gridflex-mrv-1.0.0');
    expect(result.baselineMethod).toBe('MEDIAN_SAME_INTERVAL_5_DAYS');
  });
});
