import type { Logger } from '@gridflex/config/logger';
import type { WorkerEnv } from '@gridflex/config/env';
import type { Database } from '@gridflex/db/client';
import type pg from 'pg';

export const WORKER_ENV = Symbol('WORKER_ENV');
export const WORKER_SETTINGS = Symbol('WORKER_SETTINGS');
export const WORKER_LOGGER = Symbol('WORKER_LOGGER');
export const WORKER_POOL = Symbol('WORKER_POOL');
export const WORKER_DATABASE = Symbol('WORKER_DATABASE');

export interface WorkerSettings {
  readonly runOnce: boolean;
  readonly telemetryStaleMinutes: number;
  readonly envelopeValidityMinutes: number;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  key: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

export function parseWorkerSettings(
  source: NodeJS.ProcessEnv = process.env,
): WorkerSettings {
  const runOnceValue = source.WORKER_RUN_ONCE?.trim().toLowerCase();
  if (runOnceValue !== undefined && !['true', 'false', '1', '0'].includes(runOnceValue)) {
    throw new Error('WORKER_RUN_ONCE must be true, false, 1, or 0');
  }

  return {
    runOnce: runOnceValue === 'true' || runOnceValue === '1',
    telemetryStaleMinutes: positiveInteger(
      source.WORKER_TELEMETRY_STALE_MINUTES,
      15,
      'WORKER_TELEMETRY_STALE_MINUTES',
    ),
    envelopeValidityMinutes: positiveInteger(
      source.WORKER_ENVELOPE_VALIDITY_MINUTES,
      75,
      'WORKER_ENVELOPE_VALIDITY_MINUTES',
    ),
  };
}

export type WorkerPool = pg.Pool;
export type WorkerDatabase = Database;
export type WorkerLogger = Logger;
export type WorkerEnvironment = WorkerEnv;
