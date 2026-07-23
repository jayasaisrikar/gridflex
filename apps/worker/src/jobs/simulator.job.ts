import { Inject, Injectable } from '@nestjs/common';
import { createRng, SIMULATOR_VERSION } from '@gridflex/engine';
import {
  WORKER_LOGGER,
  WORKER_POOL,
  type WorkerLogger,
  type WorkerPool,
} from '../runtime.js';

interface SimulatorConnector {
  readonly id: string;
  readonly facility_id: string;
  readonly organization_id: string;
  readonly normal_load_kw: string | null;
  readonly config_summary: unknown;
}

export interface SimulatorReading {
  readonly measuredAt: Date;
  readonly valueKw: number;
  readonly seed: number;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function simulatorSeed(configSummary: unknown, connectorId: string): number {
  const configured = objectValue(configSummary).seed;
  if (typeof configured === 'number' && Number.isSafeInteger(configured)) return configured >>> 0;

  let hash = 2_166_136_261;
  for (const character of connectorId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** One stable point per UTC minute; retries reproduce the same value and dedupe. */
export function buildSimulatorReading(options: {
  readonly now: Date;
  readonly normalLoadKw: number;
  readonly seed: number;
}): SimulatorReading {
  const minuteMs = 60_000;
  const minuteEpoch = Math.floor(options.now.getTime() / minuteMs);
  const measuredAt = new Date(minuteEpoch * minuteMs);
  const rng = createRng((options.seed ^ minuteEpoch) >>> 0);
  const jitterMilliKw = (rng() % 6_001) - 3_000;

  return {
    measuredAt,
    valueKw: Math.max(0, options.normalLoadKw + jitterMilliKw / 1_000),
    seed: options.seed,
  };
}

@Injectable()
export class SimulatorJob {
  constructor(
    @Inject(WORKER_POOL) private readonly pool: WorkerPool,
    @Inject(WORKER_LOGGER) private readonly logger: WorkerLogger,
  ) {}

  async run(): Promise<{ due: number; inserted: number; failed: number }> {
    const due = await this.pool.query<SimulatorConnector>(
      `select c.id, c.facility_id, f.organization_id, f.normal_load_kw, c.config_summary
       from connectors c
       join facilities f on f.id = c.facility_id
       where c.connector_type = 'SIMULATOR'
         and c.status in ('ACTIVE', 'DEGRADED')
         and (
           c.last_sync_at is null
           or c.last_sync_at <= now() - make_interval(secs => greatest(coalesce(c.poll_interval_seconds, 60), 30))
         )
       order by c.created_at`,
    );

    let inserted = 0;
    let failed = 0;
    for (const connector of due.rows) {
      try {
        inserted += await this.poll(connector);
      } catch (error: unknown) {
        failed += 1;
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        this.logger.error(
          { connector_id: connector.id, error_name: errorName },
          'simulator connector poll failed',
        );
        await this.pool.query(
          `update connectors
           set status = 'DEGRADED',
               last_sync_at = now(),
               last_error = 'Simulator polling failed; inspect protected worker logs.'
           where id = $1`,
          [connector.id],
        );
      }
    }

    return { due: due.rowCount ?? 0, inserted, failed };
  }

  private async poll(connector: SimulatorConnector): Promise<number> {
    const seed = simulatorSeed(connector.config_summary, connector.id);
    const reading = buildSimulatorReading({
      now: new Date(),
      normalLoadKw: Number(connector.normal_load_kw ?? '0'),
      seed,
    });

    const sync = await this.pool.query<{ id: string }>(
      `insert into connector_sync_runs (connector_id, status, started_at, source_window_start, source_window_end)
       values ($1, 'RUNNING', now(), $2, $2)
       returning id`,
      [connector.id, reading.measuredAt.toISOString()],
    );
    const syncRunId = sync.rows[0]!.id;
    const client = await this.pool.connect();

    try {
      await client.query('begin');
      const telemetry = await client.query(
        `insert into telemetry_readings
           (organization_id, facility_id, connector_id, source_key, metric_key,
            measured_at, value_double, unit, quality, ingest_run_id, metadata)
         values ($1, $2, $3, $4, 'facility.active_power_kw', $5, $6, 'kW', 'GOOD', $7, $8::jsonb)
         on conflict (facility_id, source_key, metric_key, measured_at) do nothing`,
        [
          connector.organization_id,
          connector.facility_id,
          connector.id,
          `simulator:${connector.id}`,
          reading.measuredAt.toISOString(),
          reading.valueKw,
          syncRunId,
          JSON.stringify({
            simulated: true,
            simulator_version: SIMULATOR_VERSION,
            seed: reading.seed,
          }),
        ],
      );
      const rowsInserted = telemetry.rowCount ?? 0;

      await client.query(
        `update connector_sync_runs
         set status = 'SUCCEEDED', finished_at = now(), rows_seen = 1, rows_inserted = $2
         where id = $1`,
        [syncRunId, rowsInserted],
      );
      await client.query(
        `update connectors
         set status = 'ACTIVE', last_sync_at = now(), last_success_at = now(), last_error = null
         where id = $1`,
        [connector.id],
      );
      await client.query('commit');
      return rowsInserted;
    } catch (error: unknown) {
      await client.query('rollback');
      await this.pool.query(
        `update connector_sync_runs
         set status = 'FAILED', finished_at = now(), rows_seen = 1,
             error_code = 'SIMULATOR_POLL_FAILED',
             error_message = 'Simulator polling failed; inspect protected worker logs.'
         where id = $1`,
        [syncRunId],
      );
      throw error;
    } finally {
      client.release();
    }
  }
}
