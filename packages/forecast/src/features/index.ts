/**
 * Feature and data-quality pipeline.
 *
 * Turns raw `telemetry_readings` rows into a fixed-interval feature frame that a
 * forecaster can consume. The governing rule, inherited from the MRV engine
 * (spec §14): a gap is never interpolated. A missing or non-GOOD interval stays
 * missing and is reported as a quality block, because a forecaster that cannot
 * tell "500 kW" from "we guessed 500 kW" will eventually put the guess in front
 * of an operator with a confidence number attached to it.
 *
 * Power is carried as exact milli-kilowatts throughout. Floating point enters
 * only at the boundary, via `kwNumberToMilliKw`, matching how `value_double`
 * arrives from Postgres.
 */
import { type MilliKw, kwNumberToMilliKw, medianBigInt } from '@gridflex/engine';

export const FEATURE_PIPELINE_VERSION = 'gridflex-features-1.0.0';

/** Telemetry quality, mirroring the `telemetry_quality` enum in the schema. */
export type TelemetryQuality = 'GOOD' | 'SUSPECT' | 'BAD' | 'MISSING';

/** Only GOOD readings are admitted to a feature frame. */
const ADMISSIBLE_QUALITY: TelemetryQuality = 'GOOD';

/** A single raw reading, as read from `telemetry_readings`. */
export interface RawReading {
  /** RFC 3339 UTC instant. Must end in `Z`; offsets are rejected upstream (spec §4.1). */
  readonly measuredAt: string;
  readonly valueKw: number;
  readonly quality: TelemetryQuality;
}

/** Why an interval has no value. */
export type GapReason = 'NO_READING' | 'QUALITY_EXCLUDED';

export interface QualityBlock {
  readonly intervalStart: string;
  readonly reason: GapReason;
  /** Readings that existed but were excluded, by quality. Empty for NO_READING. */
  readonly excluded: Readonly<Record<string, number>>;
}

export interface FeatureInterval {
  readonly intervalStart: string;
  /** Exact power for this interval, or null when the interval is a gap. */
  readonly powerMkw: MilliKw | null;
  /** Count of GOOD readings that produced `powerMkw`. Zero for a gap. */
  readonly sampleCount: number;
}

export interface FeatureFrame {
  readonly pipelineVersion: string;
  readonly intervalSeconds: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly intervals: readonly FeatureInterval[];
  /** Fraction of intervals carrying a value, in [0, 1]. */
  readonly completeness: number;
  readonly qualityBlocks: readonly QualityBlock[];
}

export interface BuildFeatureFrameInput {
  readonly readings: readonly RawReading[];
  /** Inclusive grid start. Must be aligned to `intervalSeconds`. */
  readonly windowStart: string;
  /** Exclusive grid end. */
  readonly windowEnd: string;
  readonly intervalSeconds: number;
}

const MILLIS_PER_SECOND = 1000;

/** Parses an RFC 3339 UTC instant to epoch milliseconds, rejecting non-UTC input. */
export function parseUtcInstant(value: string): number {
  if (!/Z$/.test(value)) {
    throw new RangeError(
      `Instant ${JSON.stringify(value)} must be UTC and end in "Z"; offsets are ambiguous once hashed`,
    );
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new RangeError(`Not a valid RFC 3339 instant: ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** Renders epoch milliseconds as a canonical RFC 3339 UTC instant. */
export function formatUtcInstant(epochMillis: number): string {
  return new Date(epochMillis).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Builds a fixed-interval feature frame.
 *
 * Readings are bucketed by interval. Within a bucket the exact median of the
 * GOOD readings becomes the interval value — median rather than mean so a single
 * spurious spike cannot drag a feature the way it would drag an average.
 */
export function buildFeatureFrame(input: BuildFeatureFrameInput): FeatureFrame {
  const { readings, intervalSeconds } = input;

  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new RangeError(`Interval seconds must be a positive integer, received ${intervalSeconds}`);
  }

  const windowStartMs = parseUtcInstant(input.windowStart);
  const windowEndMs = parseUtcInstant(input.windowEnd);
  if (windowEndMs <= windowStartMs) {
    throw new RangeError('Window end must be strictly after window start');
  }

  const intervalMs = intervalSeconds * MILLIS_PER_SECOND;
  const span = windowEndMs - windowStartMs;
  if (span % intervalMs !== 0) {
    throw new RangeError(
      `Window span ${span}ms is not a whole number of ${intervalMs}ms intervals; ` +
        'an unaligned grid would silently drop or double-count the final interval',
    );
  }
  const intervalCount = span / intervalMs;

  // Bucket index -> accepted values, and bucket index -> excluded quality tally.
  const accepted = new Map<number, MilliKw[]>();
  const excluded = new Map<number, Map<TelemetryQuality, number>>();

  for (const reading of readings) {
    const measuredMs = parseUtcInstant(reading.measuredAt);
    if (measuredMs < windowStartMs || measuredMs >= windowEndMs) {
      continue;
    }
    const bucket = Math.floor((measuredMs - windowStartMs) / intervalMs);

    if (reading.quality !== ADMISSIBLE_QUALITY) {
      let tally = excluded.get(bucket);
      if (tally === undefined) {
        tally = new Map<TelemetryQuality, number>();
        excluded.set(bucket, tally);
      }
      tally.set(reading.quality, (tally.get(reading.quality) ?? 0) + 1);
      continue;
    }

    let values = accepted.get(bucket);
    if (values === undefined) {
      values = [];
      accepted.set(bucket, values);
    }
    values.push(kwNumberToMilliKw(reading.valueKw));
  }

  const intervals: FeatureInterval[] = [];
  const qualityBlocks: QualityBlock[] = [];
  let presentCount = 0;

  for (let index = 0; index < intervalCount; index += 1) {
    const intervalStart = formatUtcInstant(windowStartMs + index * intervalMs);
    const values = accepted.get(index);

    if (values !== undefined && values.length > 0) {
      intervals.push({
        intervalStart,
        powerMkw: medianBigInt(values),
        sampleCount: values.length,
      });
      presentCount += 1;
      continue;
    }

    // A gap. Distinguish "nothing arrived" from "something arrived and we
    // refused it" — those imply different operational fixes.
    const tally = excluded.get(index);
    const reason: GapReason = tally === undefined ? 'NO_READING' : 'QUALITY_EXCLUDED';
    const excludedRecord: Record<string, number> = {};
    if (tally !== undefined) {
      for (const [quality, count] of [...tally.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        excludedRecord[quality] = count;
      }
    }

    intervals.push({ intervalStart, powerMkw: null, sampleCount: 0 });
    qualityBlocks.push({ intervalStart, reason, excluded: excludedRecord });
  }

  return {
    pipelineVersion: FEATURE_PIPELINE_VERSION,
    intervalSeconds,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    intervals,
    completeness: presentCount / intervalCount,
    qualityBlocks,
  };
}
