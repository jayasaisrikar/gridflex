/**
 * Learning loop.
 *
 * After every drill, compares what was predicted against what happened, and
 * accumulates a facility-specific correction. This is the mechanism by which a
 * facility develops its own operational flexibility model rather than inheriting
 * a generic one.
 *
 * Two deliberate constraints:
 *
 *   1. Corrections may only make forecasts MORE conservative. A facility that
 *      consistently over-delivers does not earn the right to have its forecasts
 *      inflated — the envelope, not the model, is what authorises a larger
 *      claim, and it does so on tested evidence rather than on a running
 *      average. An optimism correction would let a lucky streak talk the model
 *      into promising capacity nobody has verified.
 *
 *   2. Corrections are derived from outcomes, never from the drills that were
 *      themselves anomalous. Learning from a drill where the meter was stuck
 *      would bake the fault into the facility's model.
 */
import { type MilliKw, divideRoundHalfAwayFromZero, medianBigInt } from '@gridflex/engine';
import type { Anomaly } from '../anomaly/index.js';

export const LEARNING_ENGINE_VERSION = 'gridflex-learning-1.0.0';

/** Drills required before a correction is applied at all. */
export const MINIMUM_OUTCOMES_FOR_CORRECTION = 3;

/** Floor on the correction factor; a model is never scaled below this. */
export const MINIMUM_CORRECTION_FACTOR = 0.5;

export interface DrillOutcome {
  readonly drillId: string;
  readonly completedAt: string;
  /** What the forecaster predicted would be reducible. */
  readonly predictedReducibleMkw: MilliKw;
  /** What the MRV engine certified as delivered. */
  readonly deliveredReducibleMkw: MilliKw;
  readonly predictedRampSeconds: number;
  readonly actualRampSeconds: number;
  readonly predictedReboundMkw: MilliKw;
  readonly actualReboundMkw: MilliKw;
  /** Anomalies raised for this drill. A drill with any is excluded from learning. */
  readonly anomalies: readonly Anomaly[];
  /** True when the drill ran on simulated data. */
  readonly simulated: boolean;
}

export interface LearningResult {
  readonly learningEngineVersion: string;
  /** Multiplier applied to future forecasts. Always <= 1. */
  readonly correctionFactor: number;
  readonly outcomesConsidered: number;
  readonly outcomesUsed: number;
  readonly outcomesExcluded: readonly { drillId: string; reason: string }[];
  /** Median delivered/predicted ratio across used outcomes. */
  readonly medianDeliveryRatio: number | null;
  /** Median actual/predicted ramp ratio. Above 1 means slower than predicted. */
  readonly medianRampRatio: number | null;
  /** Median actual/predicted rebound ratio. Above 1 means worse than predicted. */
  readonly medianReboundRatio: number | null;
  readonly applied: boolean;
  readonly notes: readonly string[];
}

/** Ratio as a scaled integer to keep the arithmetic exact until the last step. */
function ratioBps(numerator: MilliKw, denominator: MilliKw): bigint | null {
  if (denominator <= 0n) return null;
  return divideRoundHalfAwayFromZero(numerator * 10_000n, denominator);
}

export function learnFromOutcomes(outcomes: readonly DrillOutcome[]): LearningResult {
  const excluded: { drillId: string; reason: string }[] = [];
  const notes: string[] = [];
  const used: DrillOutcome[] = [];

  for (const outcome of outcomes) {
    if (outcome.simulated) {
      // A simulated drill proves the pipeline works, not that the facility does.
      excluded.push({ drillId: outcome.drillId, reason: 'SIMULATED' });
      continue;
    }
    if (outcome.anomalies.length > 0) {
      excluded.push({
        drillId: outcome.drillId,
        reason: `ANOMALOUS:${outcome.anomalies.map((a) => a.code).join('+')}`,
      });
      continue;
    }
    if (outcome.predictedReducibleMkw <= 0n) {
      excluded.push({ drillId: outcome.drillId, reason: 'NO_PREDICTION' });
      continue;
    }
    used.push(outcome);
  }

  const deliveryRatios: bigint[] = [];
  const rampRatios: bigint[] = [];
  const reboundRatios: bigint[] = [];

  for (const outcome of used) {
    const delivery = ratioBps(outcome.deliveredReducibleMkw, outcome.predictedReducibleMkw);
    if (delivery !== null) deliveryRatios.push(delivery);

    if (outcome.predictedRampSeconds > 0) {
      rampRatios.push(
        divideRoundHalfAwayFromZero(
          BigInt(outcome.actualRampSeconds) * 10_000n,
          BigInt(outcome.predictedRampSeconds),
        ),
      );
    }

    const rebound = ratioBps(outcome.actualReboundMkw, outcome.predictedReboundMkw);
    if (rebound !== null) reboundRatios.push(rebound);
  }

  const medianDeliveryRatio =
    deliveryRatios.length > 0 ? Number(medianBigInt(deliveryRatios)) / 10_000 : null;
  const medianRampRatio = rampRatios.length > 0 ? Number(medianBigInt(rampRatios)) / 10_000 : null;
  const medianReboundRatio =
    reboundRatios.length > 0 ? Number(medianBigInt(reboundRatios)) / 10_000 : null;

  if (used.length < MINIMUM_OUTCOMES_FOR_CORRECTION) {
    notes.push(
      `${used.length} usable outcome(s); ${MINIMUM_OUTCOMES_FOR_CORRECTION} are required before ` +
        'a correction is applied.',
    );
    return {
      learningEngineVersion: LEARNING_ENGINE_VERSION,
      correctionFactor: 1,
      outcomesConsidered: outcomes.length,
      outcomesUsed: used.length,
      outcomesExcluded: excluded,
      medianDeliveryRatio,
      medianRampRatio,
      medianReboundRatio,
      applied: false,
      notes,
    };
  }

  // Constraint 1: only ever more conservative.
  let correctionFactor = 1;
  if (medianDeliveryRatio !== null && medianDeliveryRatio < 1) {
    correctionFactor = Math.max(MINIMUM_CORRECTION_FACTOR, medianDeliveryRatio);
    notes.push(
      `Facility delivered a median ${(medianDeliveryRatio * 100).toFixed(1)}% of prediction; ` +
        `future forecasts scaled by ${correctionFactor.toFixed(4)}.`,
    );
  } else if (medianDeliveryRatio !== null) {
    notes.push(
      `Facility over-delivered (median ${(medianDeliveryRatio * 100).toFixed(1)}%). No upward ` +
        'correction is applied; a larger claim must come from the envelope on tested evidence.',
    );
  }

  if (medianRampRatio !== null && medianRampRatio > 1.2) {
    notes.push(
      `Facility ramps a median ${medianRampRatio.toFixed(2)}x slower than predicted; response ` +
        'time estimates understate reality.',
    );
  }

  if (medianReboundRatio !== null && medianReboundRatio > 1.2) {
    notes.push(
      `Rebound runs a median ${medianReboundRatio.toFixed(2)}x above prediction; the rebound ` +
        'window may be too short.',
    );
  }

  return {
    learningEngineVersion: LEARNING_ENGINE_VERSION,
    correctionFactor: Number(correctionFactor.toFixed(4)),
    outcomesConsidered: outcomes.length,
    outcomesUsed: used.length,
    outcomesExcluded: excluded,
    medianDeliveryRatio,
    medianRampRatio,
    medianReboundRatio,
    applied: correctionFactor < 1,
    notes,
  };
}

/**
 * Applies a learned correction to a forecast.
 *
 * Separate from `learnFromOutcomes` so the correction is an explicit, visible
 * step at the call site rather than something a forecaster does invisibly.
 */
export function applyCorrection(reducibleMkw: MilliKw, correctionFactor: number): MilliKw {
  if (!(correctionFactor > 0 && correctionFactor <= 1)) {
    throw new RangeError(
      `Correction factor must be within (0, 1] — corrections may only reduce a forecast, ` +
        `received ${correctionFactor}`,
    );
  }
  const scaled = divideRoundHalfAwayFromZero(
    reducibleMkw * BigInt(Math.round(correctionFactor * 10_000)),
    10_000n,
  );
  return scaled < 0n ? 0n : scaled;
}

/** Renders a correction for display. */
export function describeCorrection(result: LearningResult): string {
  if (!result.applied) return `No correction applied (${result.outcomesUsed} usable outcome(s)).`;
  return (
    `Forecasts scaled to ${(result.correctionFactor * 100).toFixed(1)}% based on ` +
    `${result.outcomesUsed} drill outcome(s).`
  );
}
