/**
 * Seasonal-naive baseline forecaster.
 *
 * Data-centre load is strongly periodic on two cycles: time-of-day and
 * weekday/weekend. This model estimates load at the target instant from the
 * empirical distribution of historical observations sharing the same
 * (day type, time-of-day bucket), then converts load headroom into reducible
 * power against the minimum safe load.
 *
 * It is deliberately simple. With little facility history there is nothing for a
 * gradient-boosted model to learn that this does not already capture, and the
 * backtest harness exists precisely to tell you when that stops being true.
 *
 * Reducible power derives from the LOWER bound of the load interval, not the
 * median: if load turns out lower than expected there is less headroom above the
 * safe floor, so the conservative load estimate is the one that protects the
 * floor. Optimism here would put an operator over a constraint.
 */
import { type MilliKw, kwNumberToMilliKw } from '@gridflex/engine';
import type { FeatureFrame } from '../features/index.js';
import { parseUtcInstant } from '../features/index.js';
import {
  MINIMUM_DISTINCT_DAYS_PER_BUCKET,
  MINIMUM_COMPLETENESS_FOR_FORECAST,
  MINIMUM_SAMPLES_PER_BUCKET,
  type FlexibilityForecaster,
  type ForecastRefusal,
  type ForecastRequest,
  type ForecastResult,
} from './types.js';

export const SEASONAL_BASELINE_VERSION = 'gridflex-forecast-seasonal-1.0.0';

/** Width of a time-of-day bucket, in minutes. */
const BUCKET_MINUTES = 30;
const BUCKETS_PER_DAY = (24 * 60) / BUCKET_MINUTES;

const MILLIS_PER_MINUTE = 60_000;

/** Weekday and weekend load profiles differ enough to warrant separate pools. */
type DayType = 'WEEKDAY' | 'WEEKEND';

export function dayTypeOf(epochMillis: number): DayType {
  const day = new Date(epochMillis).getUTCDay();
  return day === 0 || day === 6 ? 'WEEKEND' : 'WEEKDAY';
}

export function timeOfDayBucket(epochMillis: number): number {
  const date = new Date(epochMillis);
  const minutesIntoDay = date.getUTCHours() * 60 + date.getUTCMinutes();
  return Math.floor(minutesIntoDay / BUCKET_MINUTES) % BUCKETS_PER_DAY;
}

function seasonalKey(epochMillis: number): string {
  return `${dayTypeOf(epochMillis)}:${timeOfDayBucket(epochMillis)}`;
}

/**
 * Empirical quantile by the nearest-rank method on a sorted bigint series.
 * Nearest-rank keeps the result an observed value, so no interpolation invents a
 * load level the facility has never actually run at.
 */
export function quantileBigInt(sorted: readonly bigint[], quantile: number): bigint {
  if (sorted.length === 0) {
    throw new RangeError('Quantile of an empty series is undefined');
  }
  if (!(quantile >= 0 && quantile <= 1)) {
    throw new RangeError(`Quantile must be within [0, 1], received ${quantile}`);
  }
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return sorted[rank - 1] as bigint;
}

interface SeasonalPool {
  readonly values: bigint[];
  /** Calendar days (UTC) the values came from. */
  readonly days: Set<string>;
}

/** Groups a frame's populated intervals by seasonal key. */
function buildSeasonalPools(frame: FeatureFrame): Map<string, SeasonalPool> {
  const pools = new Map<string, SeasonalPool>();
  for (const interval of frame.intervals) {
    if (interval.powerMkw === null) continue;
    const at = parseUtcInstant(interval.intervalStart);
    const key = seasonalKey(at);
    let pool = pools.get(key);
    if (pool === undefined) {
      pool = { values: [], days: new Set<string>() };
      pools.set(key, pool);
    }
    pool.values.push(interval.powerMkw);
    pool.days.add(new Date(at).toISOString().slice(0, 10));
  }
  return pools;
}

function refuse(
  refusals: readonly ForecastRefusal[],
  request: ForecastRequest,
  samplesUsed: number,
  distinctDaysUsed = 0,
): ForecastResult {
  return {
    modelVersion: SEASONAL_BASELINE_VERSION,
    status: 'INSUFFICIENT_DATA',
    reducibleMkw: 0n,
    reducibleLowerMkw: 0n,
    reducibleUpperMkw: 0n,
    modelConfidence: 0,
    horizonMinutes: request.horizonMinutes,
    completeness: request.frame.completeness,
    samplesUsed,
    distinctDaysUsed,
    intervalUnderpowered: distinctDaysUsed < MINIMUM_DISTINCT_DAYS_PER_BUCKET,
    refusals,
    warnings: [],
  };
}

/**
 * Confidence from the evidence actually available, not a tuned constant.
 *
 * Three independent penalties compound: incompleteness of the frame, thinness of
 * the seasonal pool, and width of the prediction interval relative to the
 * estimate. A wide interval means the model does not know, and the number says so.
 */
export function computeModelConfidence(params: {
  readonly completeness: number;
  readonly sampleCount: number;
  readonly distinctDays: number;
  readonly medianMkw: bigint;
  readonly lowerMkw: bigint;
  readonly upperMkw: bigint;
}): number {
  const { completeness, sampleCount, distinctDays, medianMkw, lowerMkw, upperMkw } = params;

  // Saturates at 24 same-bucket observations; below that, evidence is thin.
  const sampleFactor = Math.min(1, sampleCount / 24);

  // Day diversity saturates at 7. A bucket seen on one day cannot support a
  // claim about day-to-day behaviour no matter how many samples that day held —
  // the narrow interval it produces would otherwise read as precision.
  const dayFactor = Math.min(1, distinctDays / 7);

  const spread = upperMkw - lowerMkw;
  const scale = medianMkw > 0n ? medianMkw : 1n;
  const relativeSpread = Number(spread) / Number(scale);
  // A spread equal to the estimate itself drives this to zero.
  const precisionFactor = Math.max(0, 1 - relativeSpread);

  const raw = completeness * sampleFactor * dayFactor * precisionFactor;
  return Math.min(1, Math.max(0, Number(raw.toFixed(4))));
}

export class SeasonalBaselineForecaster implements FlexibilityForecaster {
  readonly modelVersion = SEASONAL_BASELINE_VERSION;

  forecast(request: ForecastRequest): ForecastResult {
    const { frame, horizonMinutes, minimumSafeLoadKw } = request;

    if (frame.completeness < MINIMUM_COMPLETENESS_FOR_FORECAST) {
      return refuse(
        [
          {
            code: 'FORECAST_BLOCKED_DATA_QUALITY',
            detail:
              `Telemetry completeness ${(frame.completeness * 100).toFixed(1)}% is below the ` +
              `required ${MINIMUM_COMPLETENESS_FOR_FORECAST * 100}%.`,
          },
        ],
        request,
        0,
      );
    }

    const forecastAtMs = parseUtcInstant(request.forecastAt);
    const targetMs = forecastAtMs + horizonMinutes * MILLIS_PER_MINUTE;
    const key = seasonalKey(targetMs);

    const pool = buildSeasonalPools(frame).get(key) ?? { values: [], days: new Set<string>() };
    const distinctDaysUsed = pool.days.size;

    if (pool.values.length < MINIMUM_SAMPLES_PER_BUCKET) {
      return refuse(
        [
          {
            code: 'FORECAST_INSUFFICIENT_HISTORY',
            detail:
              `Seasonal bucket ${key} has ${pool.values.length} observation(s); ` +
              `${MINIMUM_SAMPLES_PER_BUCKET} are required.`,
          },
        ],
        request,
        pool.values.length,
        distinctDaysUsed,
      );
    }

    const warnings: ForecastRefusal[] = [];
    const intervalUnderpowered = distinctDaysUsed < MINIMUM_DISTINCT_DAYS_PER_BUCKET;
    if (intervalUnderpowered) {
      warnings.push({
        code: 'FORECAST_INTERVAL_UNDERPOWERED',
        detail:
          `Seasonal bucket ${key} draws from ${distinctDaysUsed} distinct day(s); ` +
          `${MINIMUM_DISTINCT_DAYS_PER_BUCKET} are needed for the prediction interval to ` +
          'reflect day-to-day variation. The stated interval understates real uncertainty.',
      });
    }

    const sorted = [...pool.values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const loadP10 = quantileBigInt(sorted, 0.1);
    const loadP50 = quantileBigInt(sorted, 0.5);
    const loadP90 = quantileBigInt(sorted, 0.9);

    const floorMkw = kwNumberToMilliKw(minimumSafeLoadKw);
    const headroom = (loadMkw: MilliKw): MilliKw => {
      const available = loadMkw - floorMkw;
      return available > 0n ? available : 0n;
    };

    // Lower load => lower headroom, so the interval maps across, not through.
    const reducibleLowerMkw = headroom(loadP10);
    const reducibleMkw = headroom(loadP50);
    const reducibleUpperMkw = headroom(loadP90);

    return {
      modelVersion: SEASONAL_BASELINE_VERSION,
      status: 'OK',
      reducibleMkw,
      reducibleLowerMkw,
      reducibleUpperMkw,
      modelConfidence: computeModelConfidence({
        completeness: frame.completeness,
        sampleCount: pool.values.length,
        distinctDays: distinctDaysUsed,
        medianMkw: reducibleMkw,
        lowerMkw: reducibleLowerMkw,
        upperMkw: reducibleUpperMkw,
      }),
      horizonMinutes,
      completeness: frame.completeness,
      samplesUsed: pool.values.length,
      distinctDaysUsed,
      intervalUnderpowered,
      refusals: [],
      warnings,
    };
  }
}
