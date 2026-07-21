import { describe, expect, it } from 'vitest';
import { buildFeatureFrame, formatUtcInstant, parseUtcInstant, type RawReading } from '../src/features/index.js';
import {
  SEASONAL_BASELINE_VERSION,
  SeasonalBaselineForecaster,
  computeModelConfidence,
  dayTypeOf,
  quantileBigInt,
  timeOfDayBucket,
} from '../src/forecast/seasonal-baseline.js';
import { MINIMUM_SAMPLES_PER_BUCKET } from '../src/forecast/types.js';

const INTERVAL_SECONDS = 300;

/** 2026-03-02 is a Monday; 2026-03-07 is a Saturday. */
const MONDAY = '2026-03-02T00:00:00Z';

/**
 * Builds a frame spanning `days` from MONDAY, with load produced by `loadKw`
 * given the interval's instant. Every interval is GOOD unless `skip` says otherwise.
 */
function frameOf(options: {
  days: number;
  loadKw: (epochMillis: number, index: number) => number;
  skip?: (index: number) => boolean;
}) {
  const startMs = parseUtcInstant(MONDAY);
  const intervalMs = INTERVAL_SECONDS * 1000;
  const count = (options.days * 24 * 3600) / INTERVAL_SECONDS;
  const readings: RawReading[] = [];

  for (let index = 0; index < count; index += 1) {
    if (options.skip?.(index) === true) continue;
    const at = startMs + index * intervalMs;
    readings.push({
      measuredAt: formatUtcInstant(at),
      valueKw: options.loadKw(at, index),
      quality: 'GOOD',
    });
  }

  return buildFeatureFrame({
    readings,
    windowStart: MONDAY,
    windowEnd: formatUtcInstant(startMs + count * intervalMs),
    intervalSeconds: INTERVAL_SECONDS,
  });
}

const forecaster = new SeasonalBaselineForecaster();

describe('calendar features', () => {
  it('classifies weekdays and weekends', () => {
    expect(dayTypeOf(parseUtcInstant('2026-03-02T12:00:00Z'))).toBe('WEEKDAY'); // Monday
    expect(dayTypeOf(parseUtcInstant('2026-03-06T12:00:00Z'))).toBe('WEEKDAY'); // Friday
    expect(dayTypeOf(parseUtcInstant('2026-03-07T12:00:00Z'))).toBe('WEEKEND'); // Saturday
    expect(dayTypeOf(parseUtcInstant('2026-03-08T12:00:00Z'))).toBe('WEEKEND'); // Sunday
  });

  it('buckets time of day into 30-minute slots', () => {
    expect(timeOfDayBucket(parseUtcInstant('2026-03-02T00:00:00Z'))).toBe(0);
    expect(timeOfDayBucket(parseUtcInstant('2026-03-02T00:29:59Z'))).toBe(0);
    expect(timeOfDayBucket(parseUtcInstant('2026-03-02T00:30:00Z'))).toBe(1);
    expect(timeOfDayBucket(parseUtcInstant('2026-03-02T23:30:00Z'))).toBe(47);
  });
});

describe('quantileBigInt', () => {
  const series = [10n, 20n, 30n, 40n, 50n];

  it('returns an OBSERVED value, never an interpolated one', () => {
    // Nearest-rank means the result is always a load level the facility has
    // actually run at, rather than a synthetic midpoint.
    for (const q of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(series).toContain(quantileBigInt(series, q));
    }
  });

  it('computes known ranks', () => {
    expect(quantileBigInt(series, 0)).toBe(10n);
    expect(quantileBigInt(series, 0.5)).toBe(30n);
    expect(quantileBigInt(series, 1)).toBe(50n);
  });

  it('is monotonic in the quantile', () => {
    let previous = quantileBigInt(series, 0);
    for (let q = 0; q <= 1; q += 0.05) {
      const value = quantileBigInt(series, q);
      expect(value >= previous).toBe(true);
      previous = value;
    }
  });

  it('rejects an empty series and out-of-range quantiles', () => {
    expect(() => quantileBigInt([], 0.5)).toThrow(/empty series/);
    expect(() => quantileBigInt(series, 1.5)).toThrow(/within \[0, 1\]/);
    expect(() => quantileBigInt(series, -0.1)).toThrow(/within \[0, 1\]/);
  });
});

describe('SeasonalBaselineForecaster — refusals', () => {
  it('refuses when completeness is below the gate', () => {
    // Drop every third interval => ~67% complete.
    const frame = frameOf({ days: 2, loadKw: () => 1600, skip: (i) => i % 3 === 0 });
    expect(frame.completeness).toBeLessThan(0.9);

    const result = forecaster.forecast({
      frame,
      forecastAt: '2026-03-03T12:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 1000,
    });

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.reducibleMkw).toBe(0n);
    expect(result.modelConfidence).toBe(0);
    expect(result.refusals[0]?.code).toBe('FORECAST_BLOCKED_DATA_QUALITY');
  });

  it('refuses when the seasonal bucket is too thin', () => {
    // A weekday-only window carries no weekend observations at all.
    const frame = frameOf({ days: 2, loadKw: () => 1600 }); // Mon + Tue
    const result = forecaster.forecast({
      frame,
      forecastAt: '2026-03-07T12:00:00Z', // Saturday
      horizonMinutes: 30,
      minimumSafeLoadKw: 1000,
    });

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.refusals[0]?.code).toBe('FORECAST_INSUFFICIENT_HISTORY');
    expect(result.samplesUsed).toBeLessThan(MINIMUM_SAMPLES_PER_BUCKET);
  });

  it('reports zero capacity on every refusal path', () => {
    const thin = frameOf({ days: 2, loadKw: () => 1600 });
    const result = forecaster.forecast({
      frame: thin,
      forecastAt: '2026-03-07T12:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 1000,
    });
    expect(result.reducibleMkw).toBe(0n);
    expect(result.reducibleLowerMkw).toBe(0n);
    expect(result.reducibleUpperMkw).toBe(0n);
  });
});

describe('SeasonalBaselineForecaster — estimation', () => {
  it('recovers headroom on a flat load', () => {
    const frame = frameOf({ days: 7, loadKw: () => 1600 });
    const result = forecaster.forecast({
      frame,
      forecastAt: '2026-03-04T12:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 1000,
    });

    expect(result.status).toBe('OK');
    expect(result.modelVersion).toBe(SEASONAL_BASELINE_VERSION);
    // 1600 kW load - 1000 kW floor = 600 kW reducible, exactly.
    expect(result.reducibleMkw).toBe(600_000n);
  });

  it('learns a diurnal pattern rather than a flat average', () => {
    // Night 1000 kW, day 2000 kW. A flat mean model would answer 1500 for both.
    const load = (at: number) => (new Date(at).getUTCHours() < 12 ? 1000 : 2000);
    const frame = frameOf({ days: 7, loadKw: load });

    const night = forecaster.forecast({
      frame,
      forecastAt: '2026-03-04T02:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 500,
    });
    const day = forecaster.forecast({
      frame,
      forecastAt: '2026-03-04T14:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 500,
    });

    expect(night.reducibleMkw).toBe(500_000n); // 1000 - 500
    expect(day.reducibleMkw).toBe(1_500_000n); // 2000 - 500
  });

  it('separates weekday from weekend profiles', () => {
    const load = (at: number) => (dayTypeOf(at) === 'WEEKEND' ? 800 : 1600);
    const frame = frameOf({ days: 14, loadKw: load });

    const weekday = forecaster.forecast({
      frame,
      forecastAt: '2026-03-04T12:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 500,
    });
    const weekend = forecaster.forecast({
      frame,
      forecastAt: '2026-03-07T12:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 500,
    });

    expect(weekday.reducibleMkw).toBe(1_100_000n);
    expect(weekend.reducibleMkw).toBe(300_000n);
  });

  it('applies the horizon when selecting the seasonal bucket', () => {
    // Load steps up at 12:00. Forecasting at 11:45 with a 60-min horizon must
    // land in the POST-step bucket, not the current one.
    const load = (at: number) => (new Date(at).getUTCHours() < 12 ? 1000 : 2000);
    const frame = frameOf({ days: 7, loadKw: load });

    const result = forecaster.forecast({
      frame,
      forecastAt: '2026-03-04T11:45:00Z',
      horizonMinutes: 60,
      minimumSafeLoadKw: 500,
    });

    expect(result.reducibleMkw).toBe(1_500_000n);
  });

  it('never returns negative headroom when load sits below the safe floor', () => {
    // Floor above observed load means there is nothing to give, not a debt.
    const frame = frameOf({ days: 7, loadKw: () => 800 });
    const result = forecaster.forecast({
      frame,
      forecastAt: '2026-03-04T12:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 1200,
    });

    expect(result.reducibleMkw).toBe(0n);
    expect(result.reducibleLowerMkw).toBe(0n);
    expect(result.reducibleUpperMkw).toBe(0n);
  });

  it('orders the prediction interval lower <= median <= upper', () => {
    const frame = frameOf({ days: 7, loadKw: (_at, i) => 1400 + (i % 11) * 40 });
    const result = forecaster.forecast({
      frame,
      forecastAt: '2026-03-04T12:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 1000,
    });

    expect(result.reducibleLowerMkw <= result.reducibleMkw).toBe(true);
    expect(result.reducibleMkw <= result.reducibleUpperMkw).toBe(true);
  });

  it('derives the LOWER bound from low load, protecting the safe floor', () => {
    // Variable load 1200..2000. The conservative headroom estimate must come
    // from the LOW load case, because that is when the floor is nearest.
    const load = (_at: number, i: number) => (i % 2 === 0 ? 1200 : 2000);
    const frame = frameOf({ days: 7, loadKw: load });
    const result = forecaster.forecast({
      frame,
      forecastAt: '2026-03-04T12:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 1000,
    });

    // p10 load = 1200 => 200 kW headroom, not 1000 kW.
    expect(result.reducibleLowerMkw).toBe(200_000n);
    expect(result.reducibleUpperMkw).toBe(1_000_000n);
  });

  it('is deterministic across repeated calls', () => {
    const frame = frameOf({ days: 7, loadKw: (_at, i) => 1500 + (i % 7) * 25 });
    const request = {
      frame,
      forecastAt: '2026-03-04T12:00:00Z',
      horizonMinutes: 30 as const,
      minimumSafeLoadKw: 1000,
    };
    const first = forecaster.forecast(request);
    for (let i = 0; i < 5; i += 1) {
      expect(forecaster.forecast(request)).toEqual(first);
    }
  });

  it.each([15, 30, 60] as const)('supports the %i-minute horizon', (horizonMinutes) => {
    const frame = frameOf({ days: 7, loadKw: () => 1600 });
    const result = forecaster.forecast({
      frame,
      forecastAt: '2026-03-04T12:00:00Z',
      horizonMinutes,
      minimumSafeLoadKw: 1000,
    });
    expect(result.status).toBe('OK');
    expect(result.horizonMinutes).toBe(horizonMinutes);
  });
});

describe('computeModelConfidence', () => {
  const solid = {
    completeness: 1,
    sampleCount: 48,
    distinctDays: 7,
    medianMkw: 600_000n,
    lowerMkw: 590_000n,
    upperMkw: 610_000n,
  };

  it('is high when data is complete, plentiful and tight', () => {
    expect(computeModelConfidence(solid)).toBeGreaterThan(0.9);
  });

  it('falls as completeness falls', () => {
    expect(computeModelConfidence({ ...solid, completeness: 0.9 })).toBeLessThan(
      computeModelConfidence(solid),
    );
  });

  it('falls when the seasonal pool is thin', () => {
    expect(computeModelConfidence({ ...solid, sampleCount: 4 })).toBeLessThan(
      computeModelConfidence(solid),
    );
  });

  it('collapses toward zero when the interval is as wide as the estimate', () => {
    // The model does not know, and the number must say so.
    const confidence = computeModelConfidence({
      ...solid,
      lowerMkw: 0n,
      upperMkw: 600_000n,
    });
    expect(confidence).toBeLessThan(0.05);
  });

  it('stays within [0, 1] under an interval wider than the estimate', () => {
    const confidence = computeModelConfidence({
      ...solid,
      medianMkw: 100_000n,
      lowerMkw: 0n,
      upperMkw: 900_000n,
    });
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });

  it('handles a zero estimate without dividing by zero', () => {
    const confidence = computeModelConfidence({
      completeness: 1,
      sampleCount: 48,
      distinctDays: 7,
      medianMkw: 0n,
      lowerMkw: 0n,
      upperMkw: 0n,
    });
    expect(Number.isFinite(confidence)).toBe(true);
    expect(confidence).toBeGreaterThanOrEqual(0);
  });
});

describe('SeasonalBaselineForecaster — day diversity (found against real telemetry)', () => {
  it('flags an interval built from a single day as underpowered', () => {
    // A 24-hour window populates each bucket from one day only, so the six
    // samples in a 30-minute bucket are six consecutive 5-minute intervals.
    // The resulting interval measures within-bucket noise, not day-to-day
    // variation, and must not be presented as though it did.
    const frame = frameOf({ days: 1, loadKw: (_at, i) => 1600 + (i % 3) });
    const result = forecaster.forecast({
      frame,
      forecastAt: '2026-03-02T09:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 1000,
    });

    expect(result.status).toBe('OK');
    expect(result.distinctDaysUsed).toBe(1);
    expect(result.intervalUnderpowered).toBe(true);
    expect(result.warnings[0]?.code).toBe('FORECAST_INTERVAL_UNDERPOWERED');
  });

  it('does not flag a bucket drawing from several days', () => {
    const frame = frameOf({ days: 7, loadKw: () => 1600 });
    const result = forecaster.forecast({
      frame,
      forecastAt: '2026-03-04T12:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 1000,
    });

    expect(result.distinctDaysUsed).toBe(5); // five weekdays in the window
    expect(result.intervalUnderpowered).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it('penalises confidence hard when only one day contributes', () => {
    // This is the defect the real data exposed: without the day factor, a
    // one-day bucket produced a tight interval and an unearned confidence.
    const oneDay = frameOf({ days: 1, loadKw: (_at, i) => 1600 + (i % 3) });
    const sevenDay = frameOf({ days: 7, loadKw: (_at, i) => 1600 + (i % 3) });

    const single = forecaster.forecast({
      frame: oneDay,
      forecastAt: '2026-03-02T09:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 1000,
    });
    const many = forecaster.forecast({
      frame: sevenDay,
      forecastAt: '2026-03-04T09:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 1000,
    });

    expect(single.modelConfidence).toBeLessThan(many.modelConfidence);
  });

  it('day diversity is a multiplicative penalty on confidence', () => {
    const params = {
      completeness: 1,
      sampleCount: 48,
      medianMkw: 600_000n,
      lowerMkw: 590_000n,
      upperMkw: 610_000n,
    };
    const oneDay = computeModelConfidence({ ...params, distinctDays: 1 });
    const sevenDays = computeModelConfidence({ ...params, distinctDays: 7 });

    expect(oneDay).toBeCloseTo(sevenDays / 7, 3);
  });
});
