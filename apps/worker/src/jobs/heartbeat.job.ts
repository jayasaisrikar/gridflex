import { Inject, Injectable } from '@nestjs/common';
import {
  WORKER_ENV,
  WORKER_POOL,
  type WorkerEnvironment,
  type WorkerPool,
} from '../runtime.js';

@Injectable()
export class HeartbeatJob {
  private readonly startedAt = new Date().toISOString();

  constructor(
    @Inject(WORKER_POOL) private readonly pool: WorkerPool,
    @Inject(WORKER_ENV) private readonly env: WorkerEnvironment,
  ) {}

  async run(): Promise<{ last_seen_at: string }> {
    const result = await this.pool.query<{ last_seen_at: string }>(
      `insert into service_heartbeats
         (service_name, instance_id, last_seen_at, metadata)
       values ('worker', $1, now(), $2::jsonb)
       on conflict (service_name) do update
       set instance_id = excluded.instance_id,
           last_seen_at = excluded.last_seen_at,
           metadata = excluded.metadata
       returning last_seen_at`,
      [
        this.env.WORKER_INSTANCE_ID ?? 'worker-local',
        JSON.stringify({
          status: 'running',
          started_at: this.startedAt,
          process_id: process.pid,
        }),
      ],
    );

    return { last_seen_at: new Date(result.rows[0]!.last_seen_at).toISOString() };
  }
}
