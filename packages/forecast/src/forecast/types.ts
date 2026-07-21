/**
 * The forecaster contract.
 *
 * This interface exists so the statistical baseline shipped today can be
 * replaced by a gradient-boosted model later without touching any consumer.
 * Every result carries `modelVersion`, so a forecast recorded in the past can
 * always be attributed to the model that produced it.
 */
import type { MilliKw } from '@gridflex/engine';
import type { FeatureFrame } from '../features/index.js';

/** Horizons the product commits to, in minutes. */
export const SUPPORTED_HORIZONS_MIN = [15, 30, 60] as const;
export type HorizonMinutes = (typeof SUPPORTED_HORIZONS_MIN)[number];

/**
 * Minimum share of the feature frame that must carry values before a forecast
 * is attempted. Mirrors the envelope engine's data-quality gate (spec §10.2) so
 * the two layers refuse on the same evidence rather than disagreeing.
 */
export const MINIMUM_COMPLETENESS_FOR_FORECAST = 0.9;

/** Minimum same-bucket observations before a seasonal estimate is trustworthy. */
export const MINIMUM_SAMPLES_PER_BUCKET = 3;

export type ForecastStatus = 'OK' | 'INSUFFICIENT_DATA';

export interface ForecastRefusal {
  readonly code: string;
  readonly detail: string;
}

export interface ForecastRequest {
  readonly frame: FeatureFrame;
  /** Instant the forecast is made for; the horizon extends forward from here. */
  readonly forecastAt: string;
  readonly horizonMinutes: HorizonMinutes;
  /** Floor the facility may not go below, from `facility_constraints`. */
  readonly minimumSafeLoadKw: number;
}

export interface ForecastResult {
  readonly modelVersion: string;
  readonly status: ForecastStatus;
  /** Central estimate of safely reducible power. Zero when status is not OK. */
  readonly reducibleMkw: MilliKw;
  /** Conservative bound of the prediction interval (low load => low headroom). */
  readonly reducibleLowerMkw: MilliKw;
  readonly reducibleUpperMkw: MilliKw;
  /**
   * Model's own confidence in [0, 1]. This is a statistical figure ONLY and is
   * never user-facing on its own — `clampToEnvelope` subordinates it to the
   * envelope's assurance grade before any claim is made.
   */
  readonly modelConfidence: number;
  readonly horizonMinutes: number;
  readonly completeness: number;
  readonly samplesUsed: number;
  readonly refusals: readonly ForecastRefusal[];
}

export interface FlexibilityForecaster {
  readonly modelVersion: string;
  forecast(request: ForecastRequest): ForecastResult;
}
