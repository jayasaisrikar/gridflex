/**
 * Deterministic MRV (Measurement, Reporting, Verification) engine — spec §14.
 *
 * Every number this module produces lands on a Passport, so it is pure, exact
 * (bigint throughout), and records what it excluded rather than silently
 * repairing data. Gaps are NEVER interpolated for certified output.
 */
import {
  type MilliKw,
  type WattHours,
  divideRoundHalfAwayFromZero,
  energyWh,
  maxBigInt,
  medianBigInt,
  milliKwToKwString,
  performanceBps,
} from '../units.js';

export const MRV_METHODOLOGY_VERSION = 'gridflex-mrv-1.0.0';

/** A single measured interval. `power` absent means the interval is missing. */
export interface IntervalSample {
  /** Interval start, RFC 3339 UTC. */
  readonly measuredAt: string;
  /** Measured power, or null when no reading exists for this interval. */
  readonly power: MilliKw | null;
}

export interface BaselineInput {
  /**
   * Eligible historical days, most recent first. Each is the series of samples
   * covering the same clock intervals as the event window.
   */
  readonly eligibleDays: readonly {
    readonly date: string;
    readonly samples: readonly IntervalSample[];
  }[];
  /** Non-event intervals immediately preceding the event, for the fallback path. */
  readonly precedingNonEventSamples: readonly IntervalSample[];
  /** Number of intervals in the event window. */
  readonly intervalCount: number;
}

export type BaselineMethod =
  | 'MEDIAN_SAME_INTERVAL_5_DAYS'
  | 'MEDIAN_LAST_12_NON_EVENT_INTERVALS';

export interface BaselineResult {
  readonly method: BaselineMethod;
  /** One baseline value per event interval. */
  readonly series: readonly MilliKw[];
  /** Dates actually used, for the evidence record. */
  readonly eligibleDaysUsed: readonly string[];
  /** Interval indexes with insufficient history to establish a baseline. */
  readonly excludedIntervalIndexes: readonly number[];
}

export const BASELINE_DAYS = 5;
export const FALLBACK_INTERVALS = 12;

/**
 * Baseline selection (spec §14):
 *   baseline_kw_t = median(same relative interval, previous 5 eligible days)
 *   fallback      = median(last 12 non-event intervals)
 *
 * The primary method is used only when at least one eligible day supplies a
 * reading for that interval. Intervals with no history at all are excluded and
 * reported — never filled in.
 */
export function computeBaseline(input: BaselineInput): BaselineResult {
  const days = input.eligibleDays.slice(0, BASELINE_DAYS);
  const usableDays = days.filter((day) => day.samples.some((sample) => sample.power !== null));

  if (usableDays.length > 0) {
    const series: MilliKw[] = [];
    const excluded: number[] = [];

    for (let index = 0; index < input.intervalCount; index += 1) {
      const observations = usableDays
        .map((day) => day.samples[index]?.power ?? null)
        .filter((power): power is MilliKw => power !== null);

      if (observations.length === 0) {
        excluded.push(index);
        series.push(0n);
        continue;
      }
      series.push(medianBigInt(observations));
    }

    return {
      method: 'MEDIAN_SAME_INTERVAL_5_DAYS',
      series,
      eligibleDaysUsed: usableDays.map((day) => day.date),
      excludedIntervalIndexes: excluded,
    };
  }

  // Fallback: a flat baseline from recent non-event load.
  const recent = input.precedingNonEventSamples
    .slice(-FALLBACK_INTERVALS)
    .map((sample) => sample.power)
    .filter((power): power is MilliKw => power !== null);

  if (recent.length === 0) {
    throw new MrvInsufficientDataError(
      'No eligible baseline days and no non-event intervals available',
    );
  }

  const flat = medianBigInt(recent);
  return {
    method: 'MEDIAN_LAST_12_NON_EVENT_INTERVALS',
    series: Array.from({ length: input.intervalCount }, () => flat),
    eligibleDaysUsed: [],
    excludedIntervalIndexes: [],
  };
}

export class MrvInsufficientDataError extends Error {
  public readonly code = 'MRV_INSUFFICIENT_DATA';
  constructor(message: string) {
    super(message);
    this.name = 'MrvInsufficientDataError';
  }
}

export interface DeliveryInput {
  readonly baseline: BaselineResult;
  /** Measured power during the event, aligned index-for-index with the baseline. */
  readonly actual: readonly IntervalSample[];
  readonly intervalSeconds: number;
  /** Energy the drill committed to deliver. */
  readonly committedEnergyWh: WattHours;
  /** Post-event intervals used to quantify rebound. Reported, never netted off. */
  readonly reboundSamples?: readonly IntervalSample[];
}

export interface QualityBlock {
  readonly code: string;
  readonly intervalIndex: number;
  readonly detail: string;
}

export interface MrvResult {
  readonly methodologyVersion: string;
  readonly intervalSeconds: number;
  readonly baselineMethod: BaselineMethod;
  readonly baselineSeries: readonly MilliKw[];
  readonly actualSeries: readonly (MilliKw | null)[];
  readonly committedEnergyWh: WattHours;
  readonly deliveredEnergyWh: WattHours;
  readonly averageDeliveredKw: string;
  readonly performanceBps: number;
  readonly telemetryCompleteness: number;
  readonly maximumGapIntervals: number;
  readonly qualityBlocks: readonly QualityBlock[];
  readonly reboundEnergyWh: WattHours | null;
  readonly eligibleDaysUsed: readonly string[];
  readonly excludedIntervalIndexes: readonly number[];
}

/**
 * Computes delivered energy and performance (spec §14):
 *
 *   delivered_wh    = Σ max(0, baseline_kw_t - actual_kw_t) × interval_minutes × 1000 / 60
 *   performance_bps = min(10000, delivered_wh × 10000 / committed_energy_wh)
 *
 * Missing intervals contribute ZERO delivered energy and are recorded as quality
 * blocks. That is deliberately conservative: an unmeasured interval must never
 * inflate a certified claim.
 */
export function computeMrv(input: DeliveryInput): MrvResult {
  const { baseline, actual, intervalSeconds } = input;

  if (baseline.series.length !== actual.length) {
    throw new MrvInsufficientDataError(
      `Baseline series (${baseline.series.length}) and actual series (${actual.length}) must align interval-for-interval`,
    );
  }

  const excludedFromBaseline = new Set(baseline.excludedIntervalIndexes);
  const qualityBlocks: QualityBlock[] = [];

  // PRECISION INVARIANT — do not change without reading the regression test
  // "per-interval rounding DRIFTS" in tests/units.test.ts.
  //
  // Energy accumulates here as EXACT mkW-seconds and is converted to whole Wh
  // exactly once, after the loop. Converting each interval to Wh and summing the
  // rounded results inflates a 30-minute drill at 490 kW by 10 Wh, which would
  // land in a certified Passport.
  let deliveredMilliKwSeconds = 0n;
  let measuredIntervals = 0;
  let currentGap = 0;
  let maximumGapIntervals = 0;

  const actualSeries: (MilliKw | null)[] = [];

  for (let index = 0; index < actual.length; index += 1) {
    const sample = actual[index];
    const actualPower = sample?.power ?? null;
    actualSeries.push(actualPower);

    if (actualPower === null) {
      currentGap += 1;
      maximumGapIntervals = Math.max(maximumGapIntervals, currentGap);
      qualityBlocks.push({
        code: 'MISSING_INTERVAL',
        intervalIndex: index,
        detail: 'No telemetry reading; interval contributes zero delivered energy.',
      });
      continue;
    }

    currentGap = 0;
    measuredIntervals += 1;

    if (excludedFromBaseline.has(index)) {
      qualityBlocks.push({
        code: 'NO_BASELINE_HISTORY',
        intervalIndex: index,
        detail: 'No eligible historical data for this interval; excluded from delivery.',
      });
      continue;
    }

    const baselinePower = baseline.series[index] as MilliKw;
    // max(0, ...) — consuming more than baseline is not negative delivery.
    const reduction = maxBigInt(0n, baselinePower - actualPower);
    deliveredMilliKwSeconds += reduction * BigInt(intervalSeconds);
  }

  const deliveredEnergyWh = milliKwSecondsToWh(deliveredMilliKwSeconds);
  const totalSeconds = BigInt(actual.length * intervalSeconds);
  const averageDeliveredMilliKw =
    totalSeconds > 0n
      ? divideRoundHalfAwayFromZero(deliveredMilliKwSeconds, totalSeconds)
      : 0n;

  const telemetryCompleteness =
    actual.length === 0 ? 0 : measuredIntervals / actual.length;

  return {
    methodologyVersion: MRV_METHODOLOGY_VERSION,
    intervalSeconds,
    baselineMethod: baseline.method,
    baselineSeries: baseline.series,
    actualSeries,
    committedEnergyWh: input.committedEnergyWh,
    deliveredEnergyWh,
    averageDeliveredKw: milliKwToKwString(averageDeliveredMilliKw),
    performanceBps: performanceBps(deliveredEnergyWh, input.committedEnergyWh),
    telemetryCompleteness,
    maximumGapIntervals,
    qualityBlocks,
    // Rebound is reported separately and never subtracted (spec §14).
    reboundEnergyWh: input.reboundSamples
      ? computeRebound(input.reboundSamples, baseline, intervalSeconds)
      : null,
    eligibleDaysUsed: baseline.eligibleDaysUsed,
    excludedIntervalIndexes: baseline.excludedIntervalIndexes,
  };
}

/** Energy consumed ABOVE baseline after the event — the rebound. */
function computeRebound(
  samples: readonly IntervalSample[],
  baseline: BaselineResult,
  intervalSeconds: number,
): WattHours {
  // Use the median baseline as the post-event reference level.
  const reference = medianBigInt(
    baseline.series.filter((_, index) => !baseline.excludedIntervalIndexes.includes(index)),
  );

  let reboundMilliKwSeconds = 0n;
  for (const sample of samples) {
    if (sample.power === null) continue;
    reboundMilliKwSeconds += maxBigInt(0n, sample.power - reference) * BigInt(intervalSeconds);
  }
  return milliKwSecondsToWh(reboundMilliKwSeconds);
}

function milliKwSecondsToWh(milliKwSeconds: bigint): WattHours {
  return divideRoundHalfAwayFromZero(milliKwSeconds * 5n, 18_000n);
}

export { energyWh };
