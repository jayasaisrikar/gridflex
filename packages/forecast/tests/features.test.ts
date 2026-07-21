import { describe, expect, it } from 'vitest';
import {
  FEATURE_PIPELINE_VERSION,
  buildFeatureFrame,
  formatUtcInstant,
  parseUtcInstant,
  type RawReading,
} from '../src/features/index.js';

const START = '2026-03-02T00:00:00Z';

function reading(minute: number, valueKw: number, quality: RawReading['quality'] = 'GOOD'): RawReading {
  return {
    measuredAt: formatUtcInstant(parseUtcInstant(START) + minute * 60_000),
    valueKw,
    quality,
  };
}

describe('parseUtcInstant', () => {
  it('accepts a Z-suffixed instant', () => {
    expect(parseUtcInstant('2026-03-02T00:00:00Z')).toBe(Date.parse('2026-03-02T00:00:00Z'));
  });

  it('REJECTS a non-UTC offset rather than silently shifting it', () => {
    // A +05:30 offset that parsed successfully would hash to a different
    // document than the same instant written as Z. Spec §4.1 forbids this.
    expect(() => parseUtcInstant('2026-03-02T00:00:00+05:30')).toThrow(/must be UTC/);
  });

  it('rejects a malformed instant', () => {
    expect(() => parseUtcInstant('not-a-date-Z')).toThrow(/valid RFC 3339/);
  });
});

describe('buildFeatureFrame — grid construction', () => {
  const base = { windowStart: START, windowEnd: '2026-03-02T01:00:00Z', intervalSeconds: 300 };

  it('produces one interval per grid slot', () => {
    const frame = buildFeatureFrame({ ...base, readings: [] });
    expect(frame.intervals).toHaveLength(12);
    expect(frame.pipelineVersion).toBe(FEATURE_PIPELINE_VERSION);
  });

  it('rejects a window that is not a whole number of intervals', () => {
    // An unaligned grid would drop or double-count the tail interval.
    expect(() =>
      buildFeatureFrame({ ...base, windowEnd: '2026-03-02T00:57:30Z', readings: [] }),
    ).toThrow(/not a whole number/);
  });

  it('rejects a non-positive interval', () => {
    expect(() => buildFeatureFrame({ ...base, intervalSeconds: 0, readings: [] })).toThrow(
      /positive integer/,
    );
  });

  it('rejects an end at or before the start', () => {
    expect(() => buildFeatureFrame({ ...base, windowEnd: START, readings: [] })).toThrow(
      /strictly after/,
    );
  });

  it('treats the window end as exclusive', () => {
    const frame = buildFeatureFrame({
      ...base,
      readings: [{ measuredAt: '2026-03-02T01:00:00Z', valueKw: 999, quality: 'GOOD' }],
    });
    // The boundary reading belongs to the NEXT window, not this one.
    expect(frame.completeness).toBe(0);
  });

  it('ignores readings outside the window', () => {
    const frame = buildFeatureFrame({
      ...base,
      readings: [{ measuredAt: '2026-03-01T23:59:00Z', valueKw: 999, quality: 'GOOD' }],
    });
    expect(frame.completeness).toBe(0);
  });
});

describe('buildFeatureFrame — quality gating', () => {
  const base = { windowStart: START, windowEnd: '2026-03-02T00:15:00Z', intervalSeconds: 300 };

  it('admits GOOD readings', () => {
    const frame = buildFeatureFrame({ ...base, readings: [reading(0, 1600)] });
    expect(frame.intervals[0]?.powerMkw).toBe(1_600_000n);
    expect(frame.intervals[0]?.sampleCount).toBe(1);
  });

  it.each(['ESTIMATED', 'SUSPECT', 'MISSING', 'QUARANTINED'] as const)(
    'excludes %s readings',
    (quality) => {
    const frame = buildFeatureFrame({ ...base, readings: [reading(0, 1600, quality)] });
    expect(frame.intervals[0]?.powerMkw).toBeNull();
    expect(frame.qualityBlocks[0]?.reason).toBe('QUALITY_EXCLUDED');
    expect(frame.qualityBlocks[0]?.excluded).toEqual({ [quality]: 1 });
    },
  );

  it('NEVER interpolates across a gap', () => {
    // Intervals 0 and 2 are populated, 1 is empty. A naive pipeline would fill
    // interval 1 with 1500 kW. That invented number would then be forecast on,
    // and the operator would have no way to tell it from a measurement.
    const frame = buildFeatureFrame({
      ...base,
      readings: [reading(0, 1000), reading(10, 2000)],
    });
    expect(frame.intervals[0]?.powerMkw).toBe(1_000_000n);
    expect(frame.intervals[1]?.powerMkw).toBeNull();
    expect(frame.intervals[2]?.powerMkw).toBe(2_000_000n);
  });

  it('distinguishes NO_READING from QUALITY_EXCLUDED', () => {
    // These imply different fixes: a dead connector vs a misbehaving meter.
    const frame = buildFeatureFrame({
      ...base,
      readings: [reading(0, 1600, 'QUARANTINED')],
    });
    expect(frame.qualityBlocks[0]?.reason).toBe('QUALITY_EXCLUDED');
    expect(frame.qualityBlocks[1]?.reason).toBe('NO_READING');
    expect(frame.qualityBlocks[1]?.excluded).toEqual({});
  });

  it('tallies multiple exclusion qualities in one interval', () => {
    const frame = buildFeatureFrame({
      ...base,
      readings: [reading(0, 1, 'SUSPECT'), reading(1, 2, 'SUSPECT'), reading(2, 3, 'ESTIMATED')],
    });
    expect(frame.qualityBlocks[0]?.excluded).toEqual({ ESTIMATED: 1, SUSPECT: 2 });
  });

  it('keeps a good reading even when bad ones share the interval', () => {
    const frame = buildFeatureFrame({
      ...base,
      readings: [reading(0, 1600, 'QUARANTINED'), reading(1, 1500, 'GOOD')],
    });
    expect(frame.intervals[0]?.powerMkw).toBe(1_500_000n);
    expect(frame.qualityBlocks).toHaveLength(2); // intervals 1 and 2, not 0
  });
});

describe('buildFeatureFrame — aggregation', () => {
  const base = { windowStart: START, windowEnd: '2026-03-02T00:05:00Z', intervalSeconds: 300 };

  it('uses the MEDIAN within an interval, not the mean', () => {
    // 1000, 1000, 1000, 1000, 50000(spike). Mean = 10800. Median = 1000.
    // A single stuck-high meter sample must not move the feature.
    const frame = buildFeatureFrame({
      ...base,
      readings: [reading(0, 1000), reading(1, 1000), reading(2, 1000), reading(3, 1000), reading(4, 50_000)],
    });
    expect(frame.intervals[0]?.powerMkw).toBe(1_000_000n);
    expect(frame.intervals[0]?.sampleCount).toBe(5);
  });

  it('preserves exact milli-kilowatt precision', () => {
    const frame = buildFeatureFrame({ ...base, readings: [reading(0, 1600.253)] });
    expect(frame.intervals[0]?.powerMkw).toBe(1_600_253n);
  });
});

describe('buildFeatureFrame — completeness', () => {
  const base = { windowStart: START, windowEnd: '2026-03-02T00:20:00Z', intervalSeconds: 300 };

  it('reports 1.0 when every interval is populated', () => {
    const frame = buildFeatureFrame({
      ...base,
      readings: [reading(0, 1), reading(5, 1), reading(10, 1), reading(15, 1)],
    });
    expect(frame.completeness).toBe(1);
  });

  it('reports 0 for an empty frame', () => {
    expect(buildFeatureFrame({ ...base, readings: [] }).completeness).toBe(0);
  });

  it('reports the populated fraction', () => {
    const frame = buildFeatureFrame({ ...base, readings: [reading(0, 1), reading(5, 1), reading(10, 1)] });
    expect(frame.completeness).toBe(0.75);
  });

  it('counts a quality-excluded interval as incomplete', () => {
    const frame = buildFeatureFrame({
      ...base,
      readings: [reading(0, 1), reading(5, 1), reading(10, 1), reading(15, 1, 'ESTIMATED')],
    });
    expect(frame.completeness).toBe(0.75);
  });
});
