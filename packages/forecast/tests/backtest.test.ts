import { describe, expect, it } from 'vitest';
import { buildFeatureFrame, formatUtcInstant, parseUtcInstant, type RawReading } from '../src/features/index.js';
import { SeasonalBaselineForecaster } from '../src/forecast/seasonal-baseline.js';
import type { FlexibilityForecaster, ForecastRequest, ForecastResult } from '../src/forecast/types.js';
import { NOMINAL_INTERVAL_COVERAGE, runBacktest, type BacktestCase } from '../src/backtest/index.js';

const MONDAY = '2026-03-02T00:00:00Z';
const INTERVAL_SECONDS = 300;

function flatFrame(days: number, loadKw: number) {
  const startMs = parseUtcInstant(MONDAY);
  const intervalMs = INTERVAL_SECONDS * 1000;
  const count = (days * 24 * 3600) / INTERVAL_SECONDS;
  const readings: RawReading[] = [];
  for (let i = 0; i < count; i += 1) {
    readings.push({ measuredAt: formatUtcInstant(startMs + i * intervalMs), valueKw: loadKw, quality: 'GOOD' });
  }
  return buildFeatureFrame({
    readings,
    windowStart: MONDAY,
    windowEnd: formatUtcInstant(startMs + count * intervalMs),
    intervalSeconds: INTERVAL_SECONDS,
  });
}

/** A forecaster with fixed, dictated output — lets the harness itself be tested. */
class StubForecaster implements FlexibilityForecaster {
  readonly modelVersion = 'stub-1.0.0';
  constructor(private readonly next: (request: ForecastRequest) => ForecastResult) {}
  forecast(request: ForecastRequest): ForecastResult {
    return this.next(request);
  }
}

function stubResult(overrides: Partial<ForecastResult> = {}): ForecastResult {
  return {
    modelVersion: 'stub-1.0.0',
    status: 'OK',
    reducibleMkw: 600_000n,
    reducibleLowerMkw: 500_000n,
    reducibleUpperMkw: 700_000n,
    modelConfidence: 0.8,
    horizonMinutes: 30,
    completeness: 1,
    samplesUsed: 48,
    refusals: [],
    ...overrides,
  };
}

function caseOf(actualReducibleMkw: bigint): BacktestCase {
  return {
    frame: flatFrame(7, 1600),
    forecastAt: '2026-03-04T12:00:00Z',
    horizonMinutes: 30,
    minimumSafeLoadKw: 1000,
    actualReducibleMkw,
  };
}

describe('runBacktest — accuracy scoring', () => {
  it('reports zero error on a perfect forecaster', () => {
    const forecaster = new StubForecaster(() => stubResult({ reducibleMkw: 600_000n }));
    const score = runBacktest(forecaster, [caseOf(600_000n), caseOf(600_000n)]);

    expect(score.meanAbsoluteErrorKw).toBe('0.000');
    expect(score.meanBiasKw).toBe('0.000');
    expect(score.scoredCount).toBe(2);
  });

  it('reports POSITIVE bias when the model over-predicts headroom', () => {
    // Over-prediction is the dangerous direction: it promises the grid more
    // than the facility can give. The sign must be unambiguous.
    const forecaster = new StubForecaster(() => stubResult({ reducibleMkw: 700_000n }));
    const score = runBacktest(forecaster, [caseOf(600_000n)]);

    expect(score.meanBiasKw).toBe('100.000');
    expect(score.meanAbsoluteErrorKw).toBe('100.000');
  });

  it('reports NEGATIVE bias when the model under-predicts', () => {
    const forecaster = new StubForecaster(() => stubResult({ reducibleMkw: 500_000n }));
    const score = runBacktest(forecaster, [caseOf(600_000n)]);

    expect(score.meanBiasKw).toBe('-100.000');
    expect(score.meanAbsoluteErrorKw).toBe('100.000');
  });

  it('distinguishes cancelling bias from genuine accuracy', () => {
    // +100 and -100 cancel in bias but must NOT cancel in absolute error.
    let call = 0;
    const forecaster = new StubForecaster(() =>
      stubResult({ reducibleMkw: (call += 1) === 1 ? 700_000n : 500_000n }),
    );
    const score = runBacktest(forecaster, [caseOf(600_000n), caseOf(600_000n)]);

    expect(score.meanBiasKw).toBe('0.000');
    expect(score.meanAbsoluteErrorKw).toBe('100.000');
  });
});

describe('runBacktest — interval coverage', () => {
  it('reports full coverage when actuals fall inside the interval', () => {
    const forecaster = new StubForecaster(() => stubResult());
    const score = runBacktest(forecaster, [caseOf(550_000n), caseOf(650_000n)]);

    expect(score.intervalCoverage).toBe(1);
    expect(score.intervalUnderCovers).toBe(false);
  });

  it('counts the interval bounds as covered', () => {
    const forecaster = new StubForecaster(() => stubResult());
    const score = runBacktest(forecaster, [caseOf(500_000n), caseOf(700_000n)]);
    expect(score.intervalCoverage).toBe(1);
  });

  it('FLAGS a model that is accurate but lies about its uncertainty', () => {
    // Central estimate is perfect, but the stated interval is far too narrow.
    // MAE alone would call this excellent; coverage exposes it.
    let call = 0;
    const forecaster = new StubForecaster(() =>
      stubResult({
        reducibleMkw: 600_000n,
        reducibleLowerMkw: 599_000n,
        reducibleUpperMkw: 601_000n,
      }),
    );
    const cases = Array.from({ length: 10 }, () => caseOf((call += 1) % 2 === 0 ? 400_000n : 800_000n));
    const score = runBacktest(forecaster, cases);

    expect(score.intervalCoverage).toBe(0);
    expect(score.intervalUnderCovers).toBe(true);
    expect(score.nominalCoverage).toBe(NOMINAL_INTERVAL_COVERAGE);
  });

  it('does not flag coverage within tolerance of nominal', () => {
    let call = 0;
    const forecaster = new StubForecaster(() => stubResult());
    // 8 of 10 inside => 0.8 coverage, exactly nominal.
    const cases = Array.from({ length: 10 }, () => caseOf((call += 1) <= 8 ? 600_000n : 900_000n));
    const score = runBacktest(forecaster, cases);

    expect(score.intervalCoverage).toBe(0.8);
    expect(score.intervalUnderCovers).toBe(false);
  });
});

describe('runBacktest — refusals', () => {
  it('excludes refused cases from accuracy and counts them separately', () => {
    // A model that refuses everything must not score a flattering MAE of zero.
    const forecaster = new StubForecaster(() => stubResult({ status: 'INSUFFICIENT_DATA' }));
    const score = runBacktest(forecaster, [caseOf(600_000n), caseOf(600_000n)]);

    expect(score.refusedCount).toBe(2);
    expect(score.scoredCount).toBe(0);
    expect(score.caseCount).toBe(2);
    expect(score.intervalCoverage).toBe(0);
  });

  it('scores only the cases the model actually answered', () => {
    let call = 0;
    const forecaster = new StubForecaster(() =>
      (call += 1) === 1 ? stubResult({ status: 'INSUFFICIENT_DATA' }) : stubResult({ reducibleMkw: 700_000n }),
    );
    const score = runBacktest(forecaster, [caseOf(600_000n), caseOf(600_000n)]);

    expect(score.refusedCount).toBe(1);
    expect(score.scoredCount).toBe(1);
    expect(score.meanAbsoluteErrorKw).toBe('100.000');
  });

  it('handles an empty case list without dividing by zero', () => {
    const score = runBacktest(new StubForecaster(() => stubResult()), []);
    expect(score.caseCount).toBe(0);
    expect(score.meanAbsoluteErrorKw).toBe('0.000');
    expect(Number.isFinite(score.intervalCoverage)).toBe(true);
  });
});

describe('runBacktest — against the real baseline', () => {
  it('scores the seasonal baseline as near-perfect on a flat load', () => {
    const forecaster = new SeasonalBaselineForecaster();
    // Flat 1600 kW, floor 1000 => actual reducible is exactly 600 kW.
    const cases = ['2026-03-04T12:00:00Z', '2026-03-05T08:00:00Z', '2026-03-06T20:00:00Z'].map(
      (forecastAt) => ({ ...caseOf(600_000n), forecastAt }),
    );
    const score = runBacktest(forecaster, cases);

    expect(score.modelVersion).toBe(forecaster.modelVersion);
    expect(score.scoredCount).toBe(3);
    expect(score.meanAbsoluteErrorKw).toBe('0.000');
    expect(score.intervalCoverage).toBe(1);
  });
});
