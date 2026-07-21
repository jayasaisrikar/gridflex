/**
 * Anomaly detection over facility telemetry.
 *
 * Watches for behaviour that does not match the facility's own history, and for
 * drills that do not follow their committed curve. Deterministic and
 * statistical — no model, because an anomaly detector that cannot explain why it
 * fired produces alerts nobody acts on.
 *
 * The detectors use robust statistics throughout: median and MAD rather than
 * mean and standard deviation. A facility with a genuine 3x load spike would
 * inflate its own standard deviation enough to hide the next one, so the very
 * event that matters most degrades a z-score detector's ability to see it again.
 * MAD does not have that failure.
 */
import { type MilliKw, divideRoundHalfAwayFromZero, medianBigInt, milliKwToKwString } from '@gridflex/engine';
import { parseUtcInstant, type FeatureFrame } from '../features/index.js';

export const ANOMALY_ENGINE_VERSION = 'gridflex-anomaly-1.0.0';

export type AnomalySeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface Anomaly {
  readonly code: string;
  readonly severity: AnomalySeverity;
  readonly detail: string;
  readonly at: string | null;
  readonly facts: Record<string, unknown>;
}

/**
 * Modified z-score threshold. 3.5 is the conventional cutoff for MAD-based
 * outlier detection; below it, normal diurnal variation starts firing.
 */
export const MODIFIED_Z_THRESHOLD = 3.5;

/**
 * Iglewicz-Hoaglin constant. 0.6745 is the 0.75 quantile of the standard normal,
 * which is what makes MAD a consistent estimator of sigma: for normally
 * distributed data, 0.6745 * (x - median) / MAD has unit scale, so the 3.5
 * threshold means the same thing it would for a conventional z-score.
 */
const MODIFIED_Z_CONSTANT = 0.6745;

/** A meter repeating one value exactly is almost certainly stuck, not stable. */
export const STUCK_METER_MIN_REPEATS = 12;

/** Delivery below this fraction of commitment is a material shortfall. */
export const DELIVERY_SHORTFALL_FRACTION = 0.9;

/** Rebound above this multiple of the reduction is a grid-relevant spike. */
export const REBOUND_SPIKE_MULTIPLE = 1.2;

export interface MedianAbsoluteDeviation {
  readonly median: MilliKw;
  readonly mad: MilliKw;
}

export function medianAbsoluteDeviation(values: readonly MilliKw[]): MedianAbsoluteDeviation {
  if (values.length === 0) throw new RangeError('MAD of an empty series is undefined');
  const median = medianBigInt(values);
  const deviations = values.map((value) => {
    const delta = value - median;
    return delta < 0n ? -delta : delta;
  });
  return { median, mad: medianBigInt(deviations) };
}

/**
 * Modified z-score for one observation.
 *
 * Returns 0 when MAD is zero — a perfectly constant series has no scale, and
 * dividing by it would report every deviation as infinitely anomalous.
 */
export function modifiedZScore(value: MilliKw, stats: MedianAbsoluteDeviation): number {
  if (stats.mad === 0n) return 0;
  const deviation = Number(value - stats.median);
  return (MODIFIED_Z_CONSTANT * deviation) / Number(stats.mad);
}

/**
 * A window during which load was deliberately reduced.
 *
 * Found against real telemetry: the facility's completed drill produced a ~490 kW
 * reduction that the point-outlier scan reported as five CRITICAL anomalies with
 * a maximum confidence penalty. A detector that fires every time the product
 * successfully does its job gets muted, and a muted detector catches nothing.
 *
 * Intervals inside a known window are excluded from outlier and stuck-meter
 * detection. They are not unexamined — `detectDrillAnomalies` evaluates them
 * against what the drill committed to, which is the correct expectation for
 * them, rather than against the surrounding window's median.
 */
export interface KnownReductionWindow {
  /** Inclusive start, RFC 3339 UTC. */
  readonly start: string;
  /** Exclusive end, RFC 3339 UTC. */
  readonly end: string;
  readonly drillId?: string;
}

export interface TelemetryAnomalyInput {
  readonly frame: FeatureFrame;
  /** Expected interval count, used to detect a connector that stopped reporting. */
  readonly expectedCompleteness?: number;
  /** Drill windows whose reductions are expected rather than anomalous. */
  readonly knownReductionWindows?: readonly KnownReductionWindow[];
}

/** Detects anomalies in a telemetry frame alone, with no drill context. */
export function detectTelemetryAnomalies(input: TelemetryAnomalyInput): readonly Anomaly[] {
  const anomalies: Anomaly[] = [];
  const windows = (input.knownReductionWindows ?? []).map((window) => ({
    startMs: parseUtcInstant(window.start),
    endMs: parseUtcInstant(window.end),
    drillId: window.drillId,
  }));

  const insideKnownWindow = (intervalStart: string): boolean => {
    const at = parseUtcInstant(intervalStart);
    return windows.some((window) => at >= window.startMs && at < window.endMs);
  };

  const allPopulated = input.frame.intervals.filter(
    (interval): interval is typeof interval & { powerMkw: MilliKw } => interval.powerMkw !== null,
  );

  // Statistics and outlier scanning both run on ordinary operation only. A drill
  // left in the sample would also inflate MAD and mask genuine outliers around it.
  const populated = allPopulated.filter((interval) => !insideKnownWindow(interval.intervalStart));

  if (allPopulated.length === 0) {
    return [
      {
        code: 'NO_TELEMETRY',
        severity: 'CRITICAL',
        detail: 'The frame contains no usable readings.',
        at: input.frame.windowStart,
        facts: { completeness: input.frame.completeness },
      },
    ];
  }

  // Everything that remains is inside a known drill; there is no ordinary
  // operation left to characterise, so outlier detection has no baseline.
  if (populated.length === 0) {
    return [
      {
        code: 'NO_BASELINE_OUTSIDE_DRILLS',
        severity: 'INFO',
        detail: 'Every reading falls inside a known reduction window; no outlier scan was run.',
        at: input.frame.windowStart,
        facts: { known_windows: windows.length },
      },
    ];
  }

  // Data availability.
  const expected = input.expectedCompleteness ?? 0.95;
  if (input.frame.completeness < expected) {
    anomalies.push({
      code: 'TELEMETRY_COMPLETENESS_DROP',
      severity: input.frame.completeness < 0.5 ? 'CRITICAL' : 'WARNING',
      detail:
        `Completeness ${(input.frame.completeness * 100).toFixed(1)}% is below the expected ` +
        `${(expected * 100).toFixed(1)}%.`,
      at: input.frame.windowStart,
      facts: {
        completeness: input.frame.completeness,
        expected,
        quality_blocks: input.frame.qualityBlocks.length,
      },
    });
  }

  // Point outliers by modified z-score.
  const values = populated.map((interval) => interval.powerMkw);
  const stats = medianAbsoluteDeviation(values);
  for (const interval of populated) {
    const score = modifiedZScore(interval.powerMkw, stats);
    if (Math.abs(score) > MODIFIED_Z_THRESHOLD) {
      anomalies.push({
        code: score > 0 ? 'LOAD_SPIKE' : 'LOAD_DROP',
        severity: Math.abs(score) > MODIFIED_Z_THRESHOLD * 2 ? 'CRITICAL' : 'WARNING',
        detail:
          `Load ${milliKwToKwString(interval.powerMkw)} kW deviates from the window median ` +
          `${milliKwToKwString(stats.median)} kW (modified z ${score.toFixed(2)}).`,
        at: interval.intervalStart,
        facts: {
          value_kw: milliKwToKwString(interval.powerMkw),
          median_kw: milliKwToKwString(stats.median),
          mad_kw: milliKwToKwString(stats.mad),
          modified_z: Number(score.toFixed(4)),
        },
      });
    }
  }

  // A stuck meter reports a plausible value forever. It passes every range
  // check and every quality flag, which is exactly why it needs its own check.
  let runValue: MilliKw | null = null;
  let runLength = 0;
  let runStart: string | null = null;
  for (const interval of populated) {
    if (runValue !== null && interval.powerMkw === runValue) {
      runLength += 1;
    } else {
      runValue = interval.powerMkw;
      runLength = 1;
      runStart = interval.intervalStart;
    }
    if (runLength === STUCK_METER_MIN_REPEATS) {
      anomalies.push({
        code: 'METER_STUCK',
        severity: 'WARNING',
        detail:
          `Reading held at exactly ${milliKwToKwString(runValue)} kW for ` +
          `${STUCK_METER_MIN_REPEATS} consecutive intervals.`,
        at: runStart,
        facts: {
          value_kw: milliKwToKwString(runValue),
          consecutive_intervals: STUCK_METER_MIN_REPEATS,
        },
      });
    }
  }

  return anomalies;
}

export interface DrillAnomalyInput {
  /** Reduction the drill committed to. */
  readonly committedReductionMkw: MilliKw;
  /** Reduction actually delivered, from the MRV engine. */
  readonly deliveredReductionMkw: MilliKw;
  /** Baseline load the drill reduced from. */
  readonly baselineMkw: MilliKw;
  /** Peak load observed during the rebound window after the drill. */
  readonly peakReboundMkw: MilliKw | null;
  /** Cooling power during the drill and in the comparable prior window. */
  readonly coolingDuringMkw: MilliKw | null;
  readonly coolingBaselineMkw: MilliKw | null;
}

/** Detects anomalies in how a completed drill actually behaved. */
export function detectDrillAnomalies(input: DrillAnomalyInput): readonly Anomaly[] {
  const anomalies: Anomaly[] = [];

  // Delivery shortfall.
  if (input.committedReductionMkw > 0n) {
    const deliveredBps = divideRoundHalfAwayFromZero(
      input.deliveredReductionMkw * 10_000n,
      input.committedReductionMkw,
    );
    const fraction = Number(deliveredBps) / 10_000;
    if (fraction < DELIVERY_SHORTFALL_FRACTION) {
      anomalies.push({
        code: 'DELIVERY_SHORTFALL',
        severity: fraction < 0.5 ? 'CRITICAL' : 'WARNING',
        detail:
          `Delivered ${milliKwToKwString(input.deliveredReductionMkw)} kW against a committed ` +
          `${milliKwToKwString(input.committedReductionMkw)} kW (${(fraction * 100).toFixed(1)}%).`,
        at: null,
        facts: {
          committed_kw: milliKwToKwString(input.committedReductionMkw),
          delivered_kw: milliKwToKwString(input.deliveredReductionMkw),
          delivered_fraction: Number(fraction.toFixed(4)),
        },
      });
    }
  }

  // Rebound spike: recovery overshooting the pre-drill baseline is a grid
  // problem even when the drill itself delivered perfectly.
  if (input.peakReboundMkw !== null && input.baselineMkw > 0n) {
    const ratio = Number(input.peakReboundMkw) / Number(input.baselineMkw);
    if (ratio > REBOUND_SPIKE_MULTIPLE) {
      anomalies.push({
        code: 'REBOUND_SPIKE',
        severity: ratio > REBOUND_SPIKE_MULTIPLE * 1.5 ? 'CRITICAL' : 'WARNING',
        detail:
          `Rebound peaked at ${milliKwToKwString(input.peakReboundMkw)} kW, ` +
          `${ratio.toFixed(2)}x the ${milliKwToKwString(input.baselineMkw)} kW baseline.`,
        at: null,
        facts: {
          peak_rebound_kw: milliKwToKwString(input.peakReboundMkw),
          baseline_kw: milliKwToKwString(input.baselineMkw),
          rebound_ratio: Number(ratio.toFixed(4)),
        },
      });
    }
  }

  // Cooling consumption rising during a reduction suggests the reduction was
  // achieved by moving heat rather than by using less energy overall.
  if (input.coolingDuringMkw !== null && input.coolingBaselineMkw !== null && input.coolingBaselineMkw > 0n) {
    const ratio = Number(input.coolingDuringMkw) / Number(input.coolingBaselineMkw);
    if (ratio > 1.1) {
      anomalies.push({
        code: 'COOLING_CONSUMPTION_ELEVATED',
        severity: ratio > 1.25 ? 'CRITICAL' : 'WARNING',
        detail:
          `Cooling power ran ${((ratio - 1) * 100).toFixed(1)}% above its baseline during the drill.`,
        at: null,
        facts: {
          cooling_during_kw: milliKwToKwString(input.coolingDuringMkw),
          cooling_baseline_kw: milliKwToKwString(input.coolingBaselineMkw),
          ratio: Number(ratio.toFixed(4)),
        },
      });
    }
  }

  return anomalies;
}

/**
 * Confidence penalty implied by a set of anomalies.
 *
 * Returned as a penalty rather than applied, because this package sits outside
 * the assurance boundary and may not adjust a certified confidence itself. The
 * envelope engine owns that decision.
 */
export function confidencePenalty(anomalies: readonly Anomaly[]): number {
  let penalty = 0;
  for (const anomaly of anomalies) {
    if (anomaly.severity === 'CRITICAL') penalty += 0.2;
    else if (anomaly.severity === 'WARNING') penalty += 0.05;
  }
  return Math.min(1, Number(penalty.toFixed(4)));
}
