/**
 * Subordination of the forecast to the assurance envelope.
 *
 * The forecaster is a statistical model. The envelope is the certified
 * assurance layer that feeds Passports. A model estimate must therefore never
 * be able to raise a claim above what the envelope already asserts — it may only
 * lower it.
 *
 * Both the power figure and the confidence figure are clamped:
 *
 *   claimed_kw         = min(forecast_kw, envelope_kw)
 *   claimed_confidence = min(model_confidence, envelope_confidence)
 *
 * and a BLOCKED envelope forces a zero claim regardless of what the model says.
 *
 * The envelope is accepted as a minimal structural argument rather than an
 * imported `EnvelopeResult`, so this module stays decoupled from envelope
 * internals while still being bound by its output.
 */
import { type MilliKw, kwStringToMilliKw, milliKwToKwString } from '@gridflex/engine';
import type { ForecastResult } from './types.js';

/** The only envelope fields the clamp is entitled to read. */
export interface EnvelopeCeiling {
  readonly status: 'DRAFT' | 'BLOCKED';
  /** Decimal kW string, as emitted by the envelope engine. */
  readonly totalReducibleKw: string;
  readonly confidenceScore: number;
}

/** Which layer determined the final figure. */
export type BindingSide = 'FORECAST' | 'ENVELOPE' | 'ENVELOPE_BLOCKED' | 'FORECAST_REFUSED';

export interface ClampedClaim {
  /** The only power figure any consumer may present or act on. */
  readonly claimedReducibleKw: string;
  readonly claimedReducibleMkw: MilliKw;
  /** The only confidence figure any consumer may present. */
  readonly claimedConfidence: number;
  readonly bindingSide: BindingSide;
  readonly horizonMinutes: number;
  readonly modelVersion: string;
  /** Retained for diagnostics and backtesting; NOT for display. */
  readonly forecastReducibleKw: string;
  readonly forecastConfidence: number;
  readonly envelopeReducibleKw: string;
  readonly envelopeConfidence: number;
  readonly notes: readonly string[];
}

const ZERO_CLAIM_KW = '0.000';

export function clampToEnvelope(
  forecast: ForecastResult,
  envelope: EnvelopeCeiling,
): ClampedClaim {
  const envelopeMkw = kwStringToMilliKw(envelope.totalReducibleKw);
  const notes: string[] = [];

  const base = {
    horizonMinutes: forecast.horizonMinutes,
    modelVersion: forecast.modelVersion,
    forecastReducibleKw: milliKwToKwString(forecast.reducibleMkw),
    forecastConfidence: forecast.modelConfidence,
    envelopeReducibleKw: envelope.totalReducibleKw,
    envelopeConfidence: envelope.confidenceScore,
  } as const;

  // A blocked envelope is absolute. No model output survives it.
  if (envelope.status === 'BLOCKED') {
    notes.push('Envelope is BLOCKED; no flexibility may be claimed regardless of forecast.');
    return {
      ...base,
      claimedReducibleKw: ZERO_CLAIM_KW,
      claimedReducibleMkw: 0n,
      claimedConfidence: 0,
      bindingSide: 'ENVELOPE_BLOCKED',
      notes,
    };
  }

  // A refusing forecaster also yields nothing; absence of a model estimate is
  // not licence to fall back to the envelope's headline figure.
  if (forecast.status !== 'OK') {
    notes.push(
      'Forecaster refused to produce an estimate; claim is zero rather than defaulting to the envelope.',
    );
    for (const refusal of forecast.refusals) {
      notes.push(`${refusal.code}: ${refusal.detail}`);
    }
    return {
      ...base,
      claimedReducibleKw: ZERO_CLAIM_KW,
      claimedReducibleMkw: 0n,
      claimedConfidence: 0,
      bindingSide: 'FORECAST_REFUSED',
      notes,
    };
  }

  const forecastBinds = forecast.reducibleMkw <= envelopeMkw;
  const claimedMkw = forecastBinds ? forecast.reducibleMkw : envelopeMkw;
  const bindingSide: BindingSide = forecastBinds ? 'FORECAST' : 'ENVELOPE';

  if (!forecastBinds) {
    notes.push(
      `Forecast of ${milliKwToKwString(forecast.reducibleMkw)} kW exceeded the envelope ceiling ` +
        `of ${envelope.totalReducibleKw} kW and was clamped down to it.`,
    );
  }

  const claimedConfidence = Math.min(forecast.modelConfidence, envelope.confidenceScore);
  if (claimedConfidence < forecast.modelConfidence) {
    notes.push(
      `Model confidence ${forecast.modelConfidence} was reduced to the envelope assurance grade ` +
        `${envelope.confidenceScore}.`,
    );
  }

  return {
    ...base,
    claimedReducibleKw: milliKwToKwString(claimedMkw),
    claimedReducibleMkw: claimedMkw,
    claimedConfidence,
    bindingSide,
    notes,
  };
}
