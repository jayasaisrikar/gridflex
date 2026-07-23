import { unlink } from 'node:fs/promises';
import { Inject, Injectable } from '@nestjs/common';
import {
  WORKER_ENV,
  WORKER_POOL,
  WORKER_SETTINGS,
  type WorkerEnvironment,
  type WorkerPool,
  type WorkerSettings,
} from '../runtime.js';
import { safeStoragePath } from './storage-path.js';

@Injectable()
export class MaintenanceJob {
  constructor(
    @Inject(WORKER_POOL) private readonly pool: WorkerPool,
    @Inject(WORKER_ENV) private readonly env: WorkerEnvironment,
    @Inject(WORKER_SETTINGS) private readonly settings: WorkerSettings,
  ) {}

  async sweepSimulatorQuality(): Promise<{ degraded: number }> {
    const result = await this.pool.query(
      `update connectors
       set status = 'DEGRADED',
           last_error = 'Simulator telemetry is stale; worker recovery is pending.'
       where connector_type = 'SIMULATOR'
         and status = 'ACTIVE'
         and coalesce(last_success_at, created_at) <
           now() - make_interval(secs => greatest(coalesce(poll_interval_seconds, 60) * 3, 300))`,
    );
    return { degraded: result.rowCount ?? 0 };
  }

  async markStaleEnvelopes(): Promise<{ stale: number }> {
    const result = await this.pool.query<{ count: string }>(
      `with stale as (
         update envelopes e
         set status = 'STALE'
         where e.status = 'CURRENT'
           and (
             (e.valid_until is not null and e.valid_until <= now())
             or not exists (
               select 1
               from telemetry_readings tr
               where tr.facility_id = e.facility_id
                 and tr.metric_key = 'facility.active_power_kw'
                 and tr.quality in ('GOOD', 'ESTIMATED')
                 and tr.measured_at >= now() - make_interval(mins => $1)
             )
           )
         returning e.organization_id, e.facility_id, e.id
       ), audited as (
         insert into audit_logs
           (organization_id, facility_id, actor_service, action, object_type, object_id, after_state)
         select organization_id, facility_id, 'worker', 'ENVELOPE_MARKED_STALE',
                'envelopes', id::text, '{"status":"STALE"}'::jsonb
         from stale
       )
       select count(*)::text as count from stale`,
      [this.settings.telemetryStaleMinutes],
    );
    return { stale: Number(result.rows[0]?.count ?? '0') };
  }

  async propagatePassportStaleness(): Promise<{ superseded: number }> {
    const result = await this.pool.query<{ count: string }>(
      `with changed as (
         update passports p
         set status = 'SUPERSEDED'
         from envelopes e
         where p.envelope_id = e.id
           and p.status = 'ISSUED'
           and e.status in ('STALE', 'SUPERSEDED', 'BLOCKED')
         returning p.organization_id, p.facility_id, p.id
       ), audited as (
         insert into audit_logs
           (organization_id, facility_id, actor_service, action, object_type, object_id, after_state)
         select organization_id, facility_id, 'worker', 'PASSPORT_SUPERSEDED_STALE_ENVELOPE',
                'passports', id::text, '{"status":"SUPERSEDED"}'::jsonb
         from changed
       )
       select count(*)::text as count from changed`,
    );
    return { superseded: Number(result.rows[0]?.count ?? '0') };
  }

  async cleanupIdempotencyKeys(): Promise<{ deleted: number }> {
    const result = await this.pool.query('delete from idempotency_keys where expires_at <= now()');
    return { deleted: result.rowCount ?? 0 };
  }

  async cleanupExports(): Promise<{ expired: number; filesDeleted: number }> {
    const expired = await this.pool.query<{ storage_uri: string | null }>(
      `update export_packages
       set status = 'EXPIRED'
       where status = 'READY' and expires_at is not null and expires_at <= now()
       returning storage_uri`,
    );

    let filesDeleted = 0;
    for (const row of expired.rows) {
      if (!row.storage_uri) continue;
      const path = safeStoragePath(this.env.STORAGE_ROOT ?? './.data/gridflex', row.storage_uri);
      if (!path) continue;
      try {
        await unlink(path);
        filesDeleted += 1;
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }

    return { expired: expired.rowCount ?? 0, filesDeleted };
  }
}
