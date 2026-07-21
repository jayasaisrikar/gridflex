import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '@gridflex/db/client';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DATABASE } from '../../common/database/database.module.js';
import { Public } from '../../common/auth/auth.guard.js';

/**
 * Health endpoints (spec §6.2).
 *
 * Reports each dependency separately so an operator can tell WHICH subsystem is
 * degraded. Deliberately exposes no hostnames, credentials, stack traces, or SQL
 * — a public health endpoint is an information-disclosure surface.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Liveness: is the process up? No dependency checks. */
  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: can this instance actually serve traffic? */
  @Public()
  @Get('ready')
  async ready(): Promise<{
    status: 'ok' | 'degraded';
    database: 'reachable' | 'unreachable';
    schema_revision: string | null;
    worker_last_seen: string | null;
    storage: 'writable' | 'unwritable';
  }> {
    const [database, schemaRevision] = await this.checkDatabase();
    const workerLastSeen = database === 'reachable' ? await this.checkWorker() : null;
    const storage = await this.checkStorage();

    const status = database === 'reachable' && storage === 'writable' ? 'ok' : 'degraded';
    return {
      status,
      database,
      schema_revision: schemaRevision,
      worker_last_seen: workerLastSeen,
      storage,
    };
  }

  private async checkDatabase(): Promise<['reachable' | 'unreachable', string | null]> {
    try {
      const result = await this.db.execute<{ hash: string }>(
        sql`select hash from drizzle.__drizzle_migrations order by created_at desc limit 1`,
      );
      return ['reachable', result.rows[0]?.hash?.slice(0, 12) ?? null];
    } catch {
      // Swallow the detail deliberately; it goes nowhere near the response.
      return ['unreachable', null];
    }
  }

  private async checkWorker(): Promise<string | null> {
    try {
      const result = await this.db.execute<{ last_seen_at: string }>(
        sql`select last_seen_at from service_heartbeats where service_name = 'worker' limit 1`,
      );
      const lastSeen = result.rows[0]?.last_seen_at;
      return lastSeen ? new Date(lastSeen).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
    } catch {
      return null;
    }
  }

  private async checkStorage(): Promise<'writable' | 'unwritable'> {
    const root = process.env.STORAGE_ROOT ?? './.data/gridflex';
    try {
      await mkdir(root, { recursive: true });
      const probe = join(root, `.health-${process.pid}`);
      await writeFile(probe, 'ok', 'utf8');
      await unlink(probe);
      return 'writable';
    } catch {
      return 'unwritable';
    }
  }
}
