/**
 * End-to-end: raw readings -> features -> forecast -> clamp against the REAL
 * envelope engine.
 *
 * The clamp is written against a structural `EnvelopeCeiling` rather than an
 * imported `EnvelopeResult`, which keeps the packages decoupled but means
 * nothing else proves the two shapes actually line up. These tests do.
 */
import { describe, expect, it } from 'vitest';
import { computeEnvelope, type EnvelopeInput } from '@gridflex/engine';
import { buildFeatureFrame, formatUtcInstant, parseUtcInstant, type RawReading } from '../src/features/index.js';
import { SeasonalBaselineForecaster } from '../src/forecast/seasonal-baseline.js';
import { clampToEnvelope } from '../src/forecast/clamp.js';

const MONDAY = '2026-03-02T00:00:00Z';
const INTERVAL_SECONDS = 300;
const forecaster = new SeasonalBaselineForecaster();

function readingsFor(days: number, loadKw: (index: number) => number, quality: (index: number) => RawReading['quality'] = () => 'GOOD') {
  const startMs = parseUtcInstant(MONDAY);
  const count = (days * 24 * 3600) / INTERVAL_SECONDS;
  const readings: RawReading[] = [];
  for (let i = 0; i < count; i += 1) {
    readings.push({
      measuredAt: formatUtcInstant(startMs + i * INTERVAL_SECONDS * 1000),
      valueKw: loadKw(i),
      quality: quality(i),
    });
  }
  return {
    readings,
    windowStart: MONDAY,
    windowEnd: formatUtcInstant(startMs + count * INTERVAL_SECONDS * 1000),
    intervalSeconds: INTERVAL_SECONDS,
  };
}

function envelopeInput(overrides: Partial<EnvelopeInput> = {}): EnvelopeInput {
  return {
    mechanisms: [
      {
        id: 'm1',
        code: 'BATCH',
        name: 'Deferrable batch compute',
        enabled: true,
        declaredReducibleKw: 400,
        observedReducibleKw: null,
        constraintCapKw: null,
        rampKwPerMin: 200,
        maximumDurationMin: 60,
        reboundWindowMin: 30,
        testedReducibleKw: null,
        testCount: 0,
      },
    ],
    p50NormalLoadKw: 1600,
    minimumSafeLoadKw: 1000,
    maximumCurtailmentKw: 1000,
    maximumRampKwPerMin: 500,
    maximumDurationMin: 60,
    telemetryCompleteness: 1,
    modelingWindowDays: 7,
    constraintsVersion: 1,
    constraintsAgeDays: 5,
    hasExternalReview: false,
    ...overrides,
  };
}

describe('end-to-end pipeline', () => {
  it('produces a claim bounded by the real envelope engine', () => {
    const frame = buildFeatureFrame(readingsFor(7, () => 1600));
    const envelope = computeEnvelope(envelopeInput());

    const forecast = forecaster.forecast({
      frame,
      forecastAt: '2026-03-04T12:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 1000,
    });
    const claim = clampToEnvelope(forecast, envelope);

    // Raw forecast headroom is 600 kW (1600 load - 1000 floor), but the only
    // declared mechanism supports 400 kW. The envelope must bind.
    expect(forecast.reducibleMkw).toBe(600_000n);
    expect(envelope.totalReducibleKw).toBe('400.000');
    expect(claim.claimedReducibleKw).toBe('400.000');
    expect(claim.bindingSide).toBe('ENVELOPE');
  });

  it('subordinates model confidence to a DECLARED-provenance assurance grade', () => {
    const frame = buildFeatureFrame(readingsFor(7, () => 1600));
    const envelope = computeEnvelope(envelopeInput());
    const forecast = forecaster.forecast({
      frame,
      forecastAt: '2026-03-04T12:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 1000,
    });
    const claim = clampToEnvelope(forecast, envelope);

    // The model is as confident as 5 weekdays of flat, complete data allow —
    // capped by the day-diversity factor (5 of 7), NOT the >0.9 it claimed
    // before real telemetry exposed that as unearned.
    expect(forecast.modelConfidence).toBeGreaterThan(0.6);
    expect(forecast.modelConfidence).toBeLessThan(0.75);
    expect(forecast.intervalUnderpowered).toBe(false);
    // But the mechanism is only DECLARED, so the claim cannot inherit that.
    expect(claim.claimedConfidence).toBe(envelope.confidenceScore);
    expect(claim.claimedConfidence).toBeLessThan(forecast.modelConfidence);
  });

  it('yields a zero claim when telemetry quality collapses', () => {
    // Both layers gate on completeness, and they must agree rather than one
    // silently carrying the other.
    const frame = buildFeatureFrame(readingsFor(7, () => 1600, (i) => (i % 2 === 0 ? 'SUSPECT' : 'GOOD')));
    const envelope = computeEnvelope(envelopeInput({ telemetryCompleteness: frame.completeness }));

    const forecast = forecaster.forecast({
      frame,
      forecastAt: '2026-03-04T12:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 1000,
    });
    const claim = clampToEnvelope(forecast, envelope);

    expect(frame.completeness).toBeLessThan(0.9);
    expect(forecast.status).toBe('INSUFFICIENT_DATA');
    expect(envelope.status).toBe('BLOCKED');
    expect(claim.claimedReducibleKw).toBe('0.000');
    expect(claim.claimedConfidence).toBe(0);
  });

  it('never lets a large forecast survive a blocked envelope', () => {
    const frame = buildFeatureFrame(readingsFor(7, () => 5000));
    // Envelope blocked for a reason unrelated to the forecaster's own inputs:
    // the facility has no enabled mechanisms at all.
    const envelope = computeEnvelope(
      envelopeInput({ mechanisms: [], p50NormalLoadKw: 5000 }),
    );

    const forecast = forecaster.forecast({
      frame,
      forecastAt: '2026-03-04T12:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 1000,
    });
    const claim = clampToEnvelope(forecast, envelope);

    expect(forecast.status).toBe('OK');
    expect(forecast.reducibleMkw).toBe(4_000_000n);
    expect(envelope.status).toBe('BLOCKED');
    expect(claim.claimedReducibleMkw).toBe(0n);
    expect(claim.bindingSide).toBe('ENVELOPE_BLOCKED');
  });

  it('lets the forecast bind when it is more conservative than the envelope', () => {
    // Night-time load leaves little headroom even though mechanisms allow more.
    const load = (i: number) => {
      const hour = Math.floor((i * INTERVAL_SECONDS) / 3600) % 24;
      return hour < 6 ? 1100 : 1600;
    };
    const frame = buildFeatureFrame(readingsFor(7, load));
    const envelope = computeEnvelope(envelopeInput());

    const forecast = forecaster.forecast({
      frame,
      forecastAt: '2026-03-04T02:00:00Z',
      horizonMinutes: 30,
      minimumSafeLoadKw: 1000,
    });
    const claim = clampToEnvelope(forecast, envelope);

    // 1100 - 1000 = 100 kW available, well under the envelope's 400 kW.
    expect(claim.claimedReducibleKw).toBe('100.000');
    expect(claim.bindingSide).toBe('FORECAST');
  });
});
