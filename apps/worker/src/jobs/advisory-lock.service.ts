import { Inject, Injectable } from '@nestjs/common';
import { WORKER_POOL, type WorkerPool } from '../runtime.js';

export interface LockedResult<T> {
  readonly acquired: boolean;
  readonly value?: T;
}

/**
 * Session advisory locks coordinate all worker replicas without a queue service.
 * A dedicated pool client is held for the full callback because PostgreSQL
 * session locks belong to the connection, not to the transaction.
 */
@Injectable()
export class AdvisoryLockService {
  constructor(@Inject(WORKER_POOL) private readonly pool: WorkerPool) {}

  async run<T>(lockName: string, task: () => Promise<T>): Promise<LockedResult<T>> {
    const client = await this.pool.connect();
    try {
      const lock = await client.query<{ acquired: boolean }>(
        'select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired',
        [lockName],
      );
      if (lock.rows[0]?.acquired !== true) return { acquired: false };

      try {
        return { acquired: true, value: await task() };
      } finally {
        await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockName]);
      }
    } finally {
      client.release();
    }
  }
}
