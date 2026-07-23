import { describe, expect, it, vi } from 'vitest';
import type { WorkerPool } from '../src/runtime.js';
import { AdvisoryLockService } from '../src/jobs/advisory-lock.service.js';

function serviceWith(acquired: boolean) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ acquired }] })
    .mockResolvedValue({ rows: [] });
  const release = vi.fn();
  const pool = {
    connect: vi.fn().mockResolvedValue({ query, release }),
  } as unknown as WorkerPool;
  return { service: new AdvisoryLockService(pool), query, release };
}

describe('PostgreSQL advisory job locks', () => {
  it('skips the task when another worker holds the lock', async () => {
    const { service, release } = serviceWith(false);
    const task = vi.fn();

    await expect(service.run('gridflex:test', task)).resolves.toEqual({ acquired: false });
    expect(task).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('returns the task value and releases the session lock', async () => {
    const { service, query, release } = serviceWith(true);

    await expect(service.run('gridflex:test', async () => ({ count: 3 }))).resolves.toEqual({
      acquired: true,
      value: { count: 3 },
    });
    expect(query).toHaveBeenCalledWith(
      'select pg_advisory_unlock(hashtextextended($1, 0))',
      ['gridflex:test'],
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases both lock and client when the task throws', async () => {
    const { service, query, release } = serviceWith(true);

    await expect(
      service.run('gridflex:test', async () => {
        throw new Error('expected');
      }),
    ).rejects.toThrow('expected');
    expect(query).toHaveBeenCalledWith(
      'select pg_advisory_unlock(hashtextextended($1, 0))',
      ['gridflex:test'],
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
