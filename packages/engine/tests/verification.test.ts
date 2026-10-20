import { describe, expect, it } from 'vitest';
import {
  checkWorkloadSla,
  computeBaselineBand,
  computeResponseProfile,
  isSimulatedSource,
  isSourceGrade,
  SOURCE_GRADES,
  VERIFICATION_VERSION,
  type WorkloadSlaInput,
} from '../src/verification/index.js';

const KW = (kw: number) => BigInt(Math.round(kw * 1_000_000));

/** Five eligible days with a widening spread across the window. */
const DAYS = Array.from({ length: 5 }, (_, dayIndex) => ({
  date: `2026-08-${10 + dayIndex}`,
  samples: [
    { power: KW(10_000) },
    { power: KW(10_000 + (dayIndex % 2 === 0 ? 100 : -100)) },
    { power: KW(10_000 + dayIndex * 50) },
    { power: null },
  ],
}));

describe('verification additions', () => {
  it('declares its version', () => {
    expect(VERIFICATION_VERSION).toBe('gridflex-verification-1.0.0');
  });

  describe('baseline uncertainty band', () => {
    it('spans the observed min/max of the eligible days per interval', () => {
      const band = computeBaselineBand({
        eligibleDays: DAYS,
        excludedIntervalIndexes: [],
        intervalCount: 4,
      });
      expect(band.method).toBe('OBSERVED_SPREAD_5_DAYS');
      expect(band.points).toHaveLength(3);
      expect(band.points[0]).toMatchObject({ lowerKw: '10000.000', upperKw: '10000.000' });
      expect(band.points[1]).toMatchObject({ lowerKw: '9900.000', upperKw: '10100.000' });
      expect(band.points[2]).toMatchObject({ lowerKw: '10000.000', upperKw: '10200.000' });
    });

    it('leaves excluded intervals uncovered instead of inventing a band', () => {
      const band = computeBaselineBand({
        eligibleDays: DAYS,
        excludedIntervalIndexes: [1],
        intervalCount: 4,
      });
      expect(band.uncoveredIntervalIndexes).toEqual([1, 3]);
      expect(band.points.map((p) => p.intervalIndex)).toEqual([0, 2]);
    });

    it('reports the median half-width of the band', () => {
      const band = computeBaselineBand({
        eligibleDays: DAYS,
        excludedIntervalIndexes: [],
        intervalCount: 4,
      });
      // Interval 1 spans 200 kW (half 100), interval 2 spans 200 (half 100).
      expect(band.medianHalfWidthKw).toBe('100.000');
    });
  });

  describe('response profile', () => {
    const baseline = [KW(10_000), KW(10_000), KW(10_000), KW(10_000)];

    it('measures response time from the signal to the first holding interval', () => {
      const profile = computeResponseProfile({
        actual: [{ power: KW(9_800) }, { power: KW(9_500) }, { power: KW(9_500) }, { power: KW(9_500) }],
        baselineSeries: baseline,
        signalAtMs: 0,
        windowStartMs: 120_000,
        intervalSeconds: 60,
        committedReductionKw: '500.000',
        deliveredEnergyWh: 900_000n,
        committedEnergyWh: 900_000n,
      });
      // Committed 500 kW reached at index 1 (load 9,500 vs floor 9,500):
      // 1 interval (60s) plus the 120s lead from signal to window start.
      expect(profile.responseTimeSeconds).toBe(180);
      expect(profile.sustainedMinutes).toBe(3);
      expect(profile.committedReductionReached).toBe(true);
      expect(profile.deliveryRate).toBe('1.0000');
    });

    it('reports null response time when the commitment is never reached', () => {
      const profile = computeResponseProfile({
        actual: [{ power: KW(9_900) }, { power: KW(9_900) }],
        baselineSeries: baseline.slice(0, 2),
        signalAtMs: 0,
        windowStartMs: 0,
        intervalSeconds: 60,
        committedReductionKw: '500.000',
        deliveredEnergyWh: 100_000n,
        committedEnergyWh: 900_000n,
      });
      expect(profile.responseTimeSeconds).toBeNull();
      expect(profile.committedReductionReached).toBe(false);
      expect(profile.deliveryRate).toBe('0.1111');
    });

    it('handles a zero commitment without dividing by zero', () => {
      const profile = computeResponseProfile({
        actual: [{ power: KW(10_000) }],
        baselineSeries: [KW(10_000)],
        signalAtMs: 0,
        windowStartMs: 0,
        intervalSeconds: 60,
        committedReductionKw: '0.000',
        deliveredEnergyWh: 0n,
        committedEnergyWh: 0n,
      });
      expect(profile.deliveryRate).toBe('0.0000');
    });
  });

  describe('workload SLA compliance', () => {
    const workloads: WorkloadSlaInput[] = [
      {
        id: 'w1',
        name: 'Inference cluster',
        serviceClass: 'LATENCY_CRITICAL',
        observedLatencySeconds: 2,
        targetLatencySeconds: 5,
      },
      {
        id: 'w2',
        name: 'Batch training',
        serviceClass: 'DEFERRABLE',
        observedLatencySeconds: 3_600,
        targetLatencySeconds: 60,
      },
    ];

    it('passes when latency-critical jobs hold and ignores deferrable drift', () => {
      const result = checkWorkloadSla(workloads);
      expect(result.compliant).toBe(true);
      expect(result.checkedCount).toBe(1);
      expect(result.violations).toEqual([]);
    });

    it('flags a latency-critical breach and nothing else', () => {
      const result = checkWorkloadSla([
        ...workloads,
        {
          id: 'w3',
          name: 'Live API',
          serviceClass: 'LATENCY_CRITICAL',
          observedLatencySeconds: 9,
          targetLatencySeconds: 5,
        },
      ]);
      expect(result.compliant).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({ workloadId: 'w3', observedLatencySeconds: 9 });
    });
  });

  describe('source grades', () => {
    it('covers the four grades from the build doc', () => {
      expect(SOURCE_GRADES).toEqual(['METER', 'DCIM', 'CSV', 'SIMULATED']);
      expect(isSourceGrade('METER')).toBe(true);
      expect(isSourceGrade('TWITTER')).toBe(false);
      expect(isSimulatedSource('SIMULATED')).toBe(true);
      expect(isSimulatedSource('METER')).toBe(false);
    });
  });
});
