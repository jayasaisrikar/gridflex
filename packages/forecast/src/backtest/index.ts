/**
 * Backtest harness.
 *
 * Replays historical windows through a forecaster and scores it against what
 * actually happened. This is the instrument that answers "is the baseline good
 * enough, or is a gradient-boosted model now warranted?" — a question that
 * should be settled by measurement rather than by assumption.
 *
 * Scoring deliberately reports two different things:
 *
 *   - Accuracy (MAE / bias): is the central estimate right?
 *   - Interval coverage: does the stated interval contain the truth as often as
 *     it claims to? A model with good MAE and 40% coverage on an 80% interval is
 *     lying about its own uncertainty, and that is the more dangerous failure
 *     here because confidence propagates into operator-facing claims.
 */
import type { MilliKw } from '@gridflex/engine';
import { divideRoundHalfAwayFromZero, milliKwToKwString } from '@gridflex/engine';
import type { FeatureFrame } from '../features/index.js';
import type { FlexibilityForecaster, HorizonMinutes } from '../forecast/types.js';

/** Nominal coverage of the p10..p90 interval the baseline emits. */
export const NOMINAL_INTERVAL_COVERAGE = 0.8;

export interface BacktestCase {
  /** History available to the forecaster at decision time. Must not include the outcome. */
  readonly frame: FeatureFrame;
  readonly forecastAt: string;
  readonly horizonMinutes: HorizonMinutes;
  readonly minimumSafeLoadKw: number;
  /** What the reducible power actually turned out to be. */
  readonly actualReducibleMkw: MilliKw;
}

export interface BacktestScore {
  readonly modelVersion: string;
  readonly caseCount: number;
  /** Cases the forecaster refused. Excluded from accuracy, reported separately. */
  readonly refusedCount: number;
  readonly scoredCount: number;
  /** Mean absolute error, as a kW string. */
  readonly meanAbsoluteErrorKw: string;
  /** Mean signed error. Positive means the model over-predicts headroom. */
  readonly meanBiasKw: string;
  /** Share of scored cases whose actual fell inside [lower, upper]. */
  readonly intervalCoverage: number;
  readonly nominalCoverage: number;
  /** True when observed coverage is materially below nominal. */
  readonly intervalUnderCovers: boolean;
}

/** Tolerance before under-coverage is flagged, allowing for small-sample noise. */
const COVERAGE_TOLERANCE = 0.1;

export function runBacktest(
  forecaster: FlexibilityForecaster,
  cases: readonly BacktestCase[],
): BacktestScore {
  let refusedCount = 0;
  let scoredCount = 0;
  let absoluteErrorSum = 0n;
  let signedErrorSum = 0n;
  let covered = 0;

  for (const testCase of cases) {
    const result = forecaster.forecast({
      frame: testCase.frame,
      forecastAt: testCase.forecastAt,
      horizonMinutes: testCase.horizonMinutes,
      minimumSafeLoadKw: testCase.minimumSafeLoadKw,
    });

    if (result.status !== 'OK') {
      refusedCount += 1;
      continue;
    }

    scoredCount += 1;
    const error = result.reducibleMkw - testCase.actualReducibleMkw;
    signedErrorSum += error;
    absoluteErrorSum += error < 0n ? -error : error;

    if (
      testCase.actualReducibleMkw >= result.reducibleLowerMkw &&
      testCase.actualReducibleMkw <= result.reducibleUpperMkw
    ) {
      covered += 1;
    }
  }

  const divisor = BigInt(scoredCount === 0 ? 1 : scoredCount);
  const coverage = scoredCount === 0 ? 0 : covered / scoredCount;

  return {
    modelVersion: forecaster.modelVersion,
    caseCount: cases.length,
    refusedCount,
    scoredCount,
    meanAbsoluteErrorKw: milliKwToKwString(
      scoredCount === 0 ? 0n : divideRoundHalfAwayFromZero(absoluteErrorSum, divisor),
    ),
    meanBiasKw: milliKwToKwString(
      scoredCount === 0 ? 0n : divideRoundHalfAwayFromZero(signedErrorSum, divisor),
    ),
    intervalCoverage: Number(coverage.toFixed(4)),
    nominalCoverage: NOMINAL_INTERVAL_COVERAGE,
    intervalUnderCovers:
      scoredCount > 0 && coverage < NOMINAL_INTERVAL_COVERAGE - COVERAGE_TOLERANCE,
  };
}
