import { describe, expect, it } from 'vitest';
import { parseWorkerSettings } from '../src/runtime.js';
import { buildSimulatorReading, simulatorSeed } from '../src/jobs/simulator.job.js';
import { safeStoragePath } from '../src/jobs/storage-path.js';

describe('worker settings', () => {
  it('uses pilot-safe freshness defaults', () => {
    expect(parseWorkerSettings({})).toEqual({
      runOnce: false,
      telemetryStaleMinutes: 15,
      envelopeValidityMinutes: 75,
    });
  });

  it('rejects invalid intervals instead of silently accepting them', () => {
    expect(() => parseWorkerSettings({ WORKER_TELEMETRY_STALE_MINUTES: '0' })).toThrow(
      'WORKER_TELEMETRY_STALE_MINUTES',
    );
  });
});

describe('simulator polling', () => {
  it('reproduces the same labelled reading for retries in one minute', () => {
    const options = { now: new Date('2026-07-23T10:10:42Z'), normalLoadKw: 1_600, seed: 77 };
    expect(buildSimulatorReading(options)).toEqual(
      buildSimulatorReading({ ...options, now: new Date('2026-07-23T10:10:59Z') }),
    );
  });

  it('derives a stable seed when the connector has no configured seed', () => {
    expect(simulatorSeed({}, 'connector-a')).toBe(simulatorSeed(null, 'connector-a'));
    expect(simulatorSeed({}, 'connector-a')).not.toBe(simulatorSeed({}, 'connector-b'));
  });
});

describe('export cleanup path containment', () => {
  it('allows a relative file beneath storage root', () => {
    expect(safeStoragePath('/data/gridflex', 'exports/report.zip')).toBe(
      '/data/gridflex/exports/report.zip',
    );
  });

  it('rejects traversal and remote URIs', () => {
    expect(safeStoragePath('/data/gridflex', '../../etc/passwd')).toBeNull();
    expect(safeStoragePath('/data/gridflex', 's3://bucket/report.zip')).toBeNull();
  });
});
