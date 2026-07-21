import { describe, expect, it } from 'vitest';
import { kwStringToMilliKw } from '@gridflex/engine';
import { clampToEnvelope, type EnvelopeCeiling } from '../src/forecast/clamp.js';
import type { ForecastResult } from '../src/forecast/types.js';

function forecastOf(overrides: Partial<ForecastResult> = {}): ForecastResult {
  return {
    modelVersion: 'test-model-1.0.0',
    status: 'OK',
    reducibleMkw: 500_000n,
    reducibleLowerMkw: 450_000n,
    reducibleUpperMkw: 550_000n,
    modelConfidence: 0.92,
    horizonMinutes: 30,
    completeness: 1,
    samplesUsed: 48,
    refusals: [],
    ...overrides,
  };
}

function envelopeOf(overrides: Partial<EnvelopeCeiling> = {}): EnvelopeCeiling {
  return {
    status: 'DRAFT',
    totalReducibleKw: '800.000',
    confidenceScore: 0.6,
    ...overrides,
  };
}

describe('clampToEnvelope — the forecast may never raise a claim', () => {
  it('clamps power down to the envelope when the forecast exceeds it', () => {
    // This is the headline hazard: a model saying 900 kW when the certified
    // assurance layer only supports 800 kW.
    const claim = clampToEnvelope(
      forecastOf({ reducibleMkw: 900_000n }),
      envelopeOf({ totalReducibleKw: '800.000' }),
    );

    expect(claim.claimedReducibleKw).toBe('800.000');
    expect(claim.bindingSide).toBe('ENVELOPE');
    expect(claim.notes.some((n) => /clamped down/.test(n))).toBe(true);
  });

  it('clamps confidence down to the envelope assurance grade', () => {
    // 92% model confidence must not be shown next to a 60% assurance grade.
    const claim = clampToEnvelope(
      forecastOf({ modelConfidence: 0.92 }),
      envelopeOf({ confidenceScore: 0.6 }),
    );

    expect(claim.claimedConfidence).toBe(0.6);
    expect(claim.notes.some((n) => /reduced to the envelope assurance grade/.test(n))).toBe(true);
  });

  it('lets the forecast bind when it is the more conservative of the two', () => {
    const claim = clampToEnvelope(
      forecastOf({ reducibleMkw: 500_000n, modelConfidence: 0.4 }),
      envelopeOf({ totalReducibleKw: '800.000', confidenceScore: 0.6 }),
    );

    expect(claim.claimedReducibleKw).toBe('500.000');
    expect(claim.claimedConfidence).toBe(0.4);
    expect(claim.bindingSide).toBe('FORECAST');
  });

  it('EXHAUSTIVE: the claim never exceeds either input, across the grid', () => {
    // The single invariant the whole trust boundary rests on.
    const forecastKws = [0n, 1_000n, 250_000n, 500_000n, 800_000n, 1_200_000n, 5_000_000n];
    const envelopeKws = ['0.000', '0.001', '250.000', '500.000', '800.000', '1200.000'];
    const confidences = [0, 0.05, 0.35, 0.6, 0.85, 0.95, 1];

    for (const reducibleMkw of forecastKws) {
      for (const totalReducibleKw of envelopeKws) {
        for (const modelConfidence of confidences) {
          for (const confidenceScore of confidences) {
            const claim = clampToEnvelope(
              forecastOf({ reducibleMkw, modelConfidence }),
              envelopeOf({ totalReducibleKw, confidenceScore }),
            );

            expect(claim.claimedReducibleMkw <= reducibleMkw).toBe(true);
            expect(claim.claimedReducibleMkw <= kwStringToMilliKw(totalReducibleKw)).toBe(true);
            expect(claim.claimedConfidence).toBeLessThanOrEqual(modelConfidence);
            expect(claim.claimedConfidence).toBeLessThanOrEqual(confidenceScore);
            expect(claim.claimedReducibleMkw >= 0n).toBe(true);
          }
        }
      }
    }
  });
});

describe('clampToEnvelope — blocked envelope is absolute', () => {
  it('forces a zero claim even on a confident, large forecast', () => {
    const claim = clampToEnvelope(
      forecastOf({ reducibleMkw: 5_000_000n, modelConfidence: 1 }),
      envelopeOf({ status: 'BLOCKED', totalReducibleKw: '0.000', confidenceScore: 0 }),
    );

    expect(claim.claimedReducibleKw).toBe('0.000');
    expect(claim.claimedReducibleMkw).toBe(0n);
    expect(claim.claimedConfidence).toBe(0);
    expect(claim.bindingSide).toBe('ENVELOPE_BLOCKED');
  });

  it('blocks even when the blocked envelope still carries a nonzero figure', () => {
    // Defensive: status wins over the number, whatever the number says.
    const claim = clampToEnvelope(
      forecastOf({ reducibleMkw: 500_000n }),
      envelopeOf({ status: 'BLOCKED', totalReducibleKw: '800.000', confidenceScore: 0.9 }),
    );

    expect(claim.claimedReducibleMkw).toBe(0n);
    expect(claim.bindingSide).toBe('ENVELOPE_BLOCKED');
  });
});

describe('clampToEnvelope — a refusing forecaster yields nothing', () => {
  it('does NOT fall back to the envelope headline figure', () => {
    // The dangerous alternative: no forecast, so show the envelope's 800 kW.
    // That would present an unforecast number as though it were predicted.
    const claim = clampToEnvelope(
      forecastOf({
        status: 'INSUFFICIENT_DATA',
        reducibleMkw: 0n,
        modelConfidence: 0,
        refusals: [{ code: 'FORECAST_BLOCKED_DATA_QUALITY', detail: 'completeness 41.0%' }],
      }),
      envelopeOf({ totalReducibleKw: '800.000', confidenceScore: 0.9 }),
    );

    expect(claim.claimedReducibleKw).toBe('0.000');
    expect(claim.claimedConfidence).toBe(0);
    expect(claim.bindingSide).toBe('FORECAST_REFUSED');
  });

  it('propagates the refusal reasons into the notes', () => {
    const claim = clampToEnvelope(
      forecastOf({
        status: 'INSUFFICIENT_DATA',
        refusals: [{ code: 'FORECAST_INSUFFICIENT_HISTORY', detail: 'bucket WEEKEND:24 has 1' }],
      }),
      envelopeOf(),
    );

    expect(claim.notes.join(' ')).toContain('FORECAST_INSUFFICIENT_HISTORY');
    expect(claim.notes.join(' ')).toContain('bucket WEEKEND:24 has 1');
  });
});

describe('clampToEnvelope — diagnostics are retained but separated', () => {
  it('preserves both raw inputs alongside the clamped claim', () => {
    const claim = clampToEnvelope(
      forecastOf({ reducibleMkw: 900_000n, modelConfidence: 0.92 }),
      envelopeOf({ totalReducibleKw: '800.000', confidenceScore: 0.6 }),
    );

    // Backtesting needs the unclamped figure; display must never use it.
    expect(claim.forecastReducibleKw).toBe('900.000');
    expect(claim.forecastConfidence).toBe(0.92);
    expect(claim.envelopeReducibleKw).toBe('800.000');
    expect(claim.envelopeConfidence).toBe(0.6);
    expect(claim.claimedReducibleKw).toBe('800.000');
  });

  it('carries the model version through for attribution', () => {
    const claim = clampToEnvelope(forecastOf({ modelVersion: 'gbm-2.1.0' }), envelopeOf());
    expect(claim.modelVersion).toBe('gbm-2.1.0');
  });

  it('emits no clamp note when the forecast was already conservative', () => {
    const claim = clampToEnvelope(
      forecastOf({ reducibleMkw: 100_000n, modelConfidence: 0.1 }),
      envelopeOf({ totalReducibleKw: '800.000', confidenceScore: 0.6 }),
    );
    expect(claim.notes).toHaveLength(0);
  });

  it('handles an exact tie without reporting a clamp', () => {
    const claim = clampToEnvelope(
      forecastOf({ reducibleMkw: 800_000n, modelConfidence: 0.6 }),
      envelopeOf({ totalReducibleKw: '800.000', confidenceScore: 0.6 }),
    );
    expect(claim.bindingSide).toBe('FORECAST');
    expect(claim.claimedReducibleKw).toBe('800.000');
    expect(claim.notes).toHaveLength(0);
  });

  it('preserves exact sub-kW precision through the clamp', () => {
    const claim = clampToEnvelope(
      forecastOf({ reducibleMkw: 800_001n }),
      envelopeOf({ totalReducibleKw: '800.000' }),
    );
    // One milli-kilowatt over the ceiling still clamps.
    expect(claim.claimedReducibleKw).toBe('800.000');
    expect(claim.bindingSide).toBe('ENVELOPE');
  });
});
