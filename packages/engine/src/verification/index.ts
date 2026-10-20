/**
 * Verification additions (Product & Build Doc, "Verification method").
 *
 * A hash proves a record was not changed after it was issued; it does not
 * prove the meter readings were right. These deterministic companions to the
 * MRV engine state HOW each number was measured and how sure it is:
 *
 *   - baseline uncertainty band, computed from the spread of the eligible
 *     days behind the median, for every chart and every Proof
 *   - response time and sustained duration as headline fields
 *   - per-workload SLA compliance for latency-critical jobs
 *   - source grade per series (meter, DCIM, CSV, simulated)
 *
 * Everything here is pure and side-effect free, in the engine's trust
 * boundary: certified numbers stay exact (BigInt/decimal strings), bands are
 * honest spreads of observed data — never invented confidence percentages.
 */

import type { MilliKw } from '../units.js';

export const VERIFICATION_VERSION = 'gridflex-verification-1.0.0';

/** Provenance grade of a data series, reported on every chart and Proof. */
export type SourceGrade = 'METER' | 'DCIM' | 'CSV' | 'SIMULATED';

export const SOURCE_GRADES: readonly SourceGrade[] = ['METER', 'DCIM', 'CSV', 'SIMULATED'];

export function isSourceGrade(value: string): value is SourceGrade {
  return (SOURCE_GRADES as readonly string[]).includes(value);
}

/** True when a series must carry the visible "simulated" labelling. */
export function isSimulatedSource(grade: SourceGrade): boolean {
  return grade === 'SIMULATED';
}

export interface BaselineBandPoint {
  readonly intervalIndex: number;
  /** Lower edge of the observed spread behind the median, kW decimal string. */
  readonly lowerKw: string;
  /** Upper edge of the observed spread behind the median, kW decimal string. */
  readonly upperKw: string;
}

export interface BaselineBand {
  readonly method: 'OBSERVED_SPREAD_5_DAYS';
  readonly points: readonly BaselineBandPoint[];
  /** Median half-width of the band across measured intervals, kW string. */
  readonly medianHalfWidthKw: string;
  /** Intervals with no band because history was excluded. */
  readonly uncoveredIntervalIndexes: readonly number[];
}

function milliKwToKwString(mkw: MilliKw): string {
  const negative = mkw < 0n;
  const magnitude = negative ? -mkw : mkw;
  const whole = magnitude / 1_000_000n;
  const fraction = magnitude % 1_000_000n;
  // Engine kW strings carry three decimals; milli-kW maps 1:1 onto 1e-3 kW.
  return `${negative ? '-' : ''}${whole}.${(fraction / 1000n).toString().padStart(3, '0')}`;
}

function medianBigInt(values: readonly MilliKw[]): MilliKw {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = sorted.length >> 1;
  const odd = sorted.length % 2 === 1;
  if (odd) return sorted[middle] as MilliKw;
  const a = sorted[middle - 1] as MilliKw;
  const b = sorted[middle] as MilliKw;
  return (a + b) / 2n;
}

/**
 * Observed-spread uncertainty band for a median-of-days baseline.
 *
 * For each interval the band is [min, max] of the same-interval observations
 * across the eligible days that the baseline actually used. It is a faithful
 * picture of day-to-day variation — no distribution is assumed, no number is
 * smoothed in. Intervals the baseline excluded get no band.
 */
export function computeBaselineBand(input: {
  readonly eligibleDays: readonly {
    readonly date: string;
    readonly samples: readonly { readonly power: MilliKw | null }[];
  }[];
  readonly excludedIntervalIndexes: readonly number[];
  readonly intervalCount: number;
}): BaselineBand {
  const excluded = new Set(input.excludedIntervalIndexes);
  const usableDays = input.eligibleDays.filter((day) =>
    day.samples.some((sample) => sample.power !== null),
  );

  const points: BaselineBandPoint[] = [];
  const uncovered: number[] = [];
  const halfWidths: MilliKw[] = [];

  for (let index = 0; index < input.intervalCount; index += 1) {
    if (excluded.has(index)) {
      uncovered.push(index);
      continue;
    }
    const observations = usableDays
      .map((day) => day.samples[index]?.power ?? null)
      .filter((power): power is MilliKw => power !== null);

    if (observations.length === 0) {
      uncovered.push(index);
      continue;
    }

    const lower = observations.reduce((a, b) => (b < a ? b : a));
    const upper = observations.reduce((a, b) => (b > a ? b : a));
    points.push({
      intervalIndex: index,
      lowerKw: milliKwToKwString(lower),
      upperKw: milliKwToKwString(upper),
    });
    halfWidths.push((upper - lower) / 2n);
  }

  const medianHalfWidth = halfWidths.length > 0 ? medianBigInt(halfWidths) : 0n;

  return {
    method: 'OBSERVED_SPREAD_5_DAYS',
    points,
    medianHalfWidthKw: milliKwToKwString(medianHalfWidth),
    uncoveredIntervalIndexes: uncovered,
  };
}

export interface ResponseProfileInput {
  /** Event-window samples, aligned index-for-index with the baseline series. */
  readonly actual: readonly { readonly power: MilliKw | null }[];
  readonly baselineSeries: readonly MilliKw[];
  /** Milliseconds the grid signal (or drill request) was received. */
  readonly signalAtMs: number;
  /** Milliseconds of the first event-window interval. */
  readonly windowStartMs: number;
  readonly intervalSeconds: number;
  /** The reduction the event committed to, kW decimal string. */
  readonly committedReductionKw: string;
  /** Delivered energy from computeMrv, Wh. */
  readonly deliveredEnergyWh: bigint;
  /** Committed energy, Wh. */
  readonly committedEnergyWh: bigint;
}

export interface ResponseProfile {
  /** Signal received → committed reduction first reached. Null if never reached. */
  readonly responseTimeSeconds: number | null;
  /** Minutes held at or above the committed reduction. */
  readonly sustainedMinutes: number;
  /** Delivered ÷ committed energy, as a fraction string with 4 decimals. */
  readonly deliveryRate: string;
  readonly committedReductionReached: boolean;
}

function kwStringToMilliKw(value: string): MilliKw {
  const [whole = '0', frac = ''] = value.split('.');
  const negative = value.startsWith('-');
  const cleanFrac = (frac ?? '0').replace(/[^0-9]/g, '').padEnd(6, '0').slice(0, 6);
  const magnitude = BigInt(whole) * 1_000_000n + BigInt(cleanFrac);
  return negative ? -magnitude : magnitude;
}

/**
 * Response time and sustained duration against the committed reduction.
 *
 * An interval "holds" when actual load is at or below baseline minus the
 * committed reduction. Response time is measured from the signal instant to
 * the FIRST holding interval — optimistic rounding is never applied; if the
 * commitment is never reached, response time is null and the headline says so.
 */
export function computeResponseProfile(input: ResponseProfileInput): ResponseProfile {
  const committedMkw = kwStringToMilliKw(input.committedReductionKw);
  let firstHoldIndex: number | null = null;
  let holdingIntervals = 0;

  for (let index = 0; index < input.actual.length; index += 1) {
    const actual = input.actual[index]?.power ?? null;
    if (actual === null) continue;
    const baseline = input.baselineSeries[index] as MilliKw | undefined;
    if (baseline === undefined) continue;
    const delivered = baseline - actual;
    if (delivered >= committedMkw) {
      if (firstHoldIndex === null) firstHoldIndex = index;
      holdingIntervals += 1;
    }
  }

  const responseTimeSeconds =
    firstHoldIndex === null
      ? null
      : Math.round(
          firstHoldIndex * input.intervalSeconds +
            Math.max(0, input.windowStartMs - input.signalAtMs) / 1000,
        );

  const rateMilli =
    input.committedEnergyWh === 0n
      ? 0n
      : (input.deliveredEnergyWh * 10_000n) / input.committedEnergyWh;
  const rateWhole = rateMilli / 10_000n;
  const rateFrac = rateMilli % 10_000n;

  return {
    responseTimeSeconds,
    sustainedMinutes: (holdingIntervals * input.intervalSeconds) / 60,
    deliveryRate: `${rateWhole}.${rateFrac.toString().padStart(4, '0')}`,
    committedReductionReached: firstHoldIndex !== null,
  };
}

export type WorkloadServiceClass = 'LATENCY_CRITICAL' | 'DEFERRABLE';

export interface WorkloadSlaInput {
  readonly id: string;
  readonly name: string;
  readonly serviceClass: WorkloadServiceClass;
  /** Observed worst-case latency during the event, seconds. */
  readonly observedLatencySeconds: number;
  /** The job's latency commitment, seconds. */
  readonly targetLatencySeconds: number;
}

export interface WorkloadSlaViolation {
  readonly workloadId: string;
  readonly workloadName: string;
  readonly observedLatencySeconds: number;
  readonly targetLatencySeconds: number;
}

export interface WorkloadSlaResult {
  /** False if ANY latency-critical job missed its target. */
  readonly compliant: boolean;
  readonly checkedCount: number;
  readonly violations: readonly WorkloadSlaViolation[];
}

/**
 * SLA compliance check (Product & Build Doc: "did any latency-critical job
 * miss its target?"). Deferrable jobs may legitimately be delayed — that is
 * the mechanism — so only LATENCY_CRITICAL jobs can violate. Target: zero
 * violations on every certified event.
 */
export function checkWorkloadSla(workloads: readonly WorkloadSlaInput[]): WorkloadSlaResult {
  const violations: WorkloadSlaViolation[] = [];
  for (const workload of workloads) {
    if (workload.serviceClass !== 'LATENCY_CRITICAL') continue;
    if (workload.observedLatencySeconds > workload.targetLatencySeconds) {
      violations.push({
        workloadId: workload.id,
        workloadName: workload.name,
        observedLatencySeconds: workload.observedLatencySeconds,
        targetLatencySeconds: workload.targetLatencySeconds,
      });
    }
  }
  return {
    compliant: violations.length === 0,
    checkedCount: workloads.filter((w) => w.serviceClass === 'LATENCY_CRITICAL').length,
    violations,
  };
}
