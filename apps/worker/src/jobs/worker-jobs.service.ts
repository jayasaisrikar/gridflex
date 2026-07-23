import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  WORKER_LOGGER,
  type WorkerLogger,
} from '../runtime.js';
import { AdvisoryLockService } from './advisory-lock.service.js';
import { EnvelopeJob } from './envelope.job.js';
import { HeartbeatJob } from './heartbeat.job.js';
import { MaintenanceJob } from './maintenance.job.js';
import { SimulatorJob } from './simulator.job.js';

type JobResult = Record<string, unknown>;

@Injectable()
export class WorkerJobsService implements OnApplicationBootstrap {
  constructor(
    private readonly locks: AdvisoryLockService,
    private readonly envelope: EnvelopeJob,
    private readonly heartbeat: HeartbeatJob,
    private readonly maintenance: MaintenanceJob,
    private readonly simulator: SimulatorJob,
    @Inject(WORKER_LOGGER) private readonly logger: WorkerLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.execute('heartbeat', () => this.heartbeat.run());
  }

  @Cron('*/30 * * * * *', { name: 'heartbeat', timeZone: 'UTC', waitForCompletion: true })
  async heartbeatScheduled(): Promise<boolean> {
    return this.execute('heartbeat', () => this.heartbeat.run());
  }

  @Cron('*/30 * * * * *', {
    name: 'simulator-polling',
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  async simulatorScheduled(): Promise<boolean> {
    return this.executeLocked('gridflex:worker:simulator-polling', 'simulator-polling', () =>
      this.simulator.run(),
    );
  }

  @Cron('0 */5 * * * *', {
    name: 'telemetry-quality',
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  async telemetryQualityScheduled(): Promise<boolean> {
    return this.executeLocked('gridflex:worker:telemetry-quality', 'telemetry-quality', () =>
      this.maintenance.sweepSimulatorQuality(),
    );
  }

  @Cron('0 */15 * * * *', {
    name: 'staleness-propagation',
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  async stalenessScheduled(): Promise<boolean> {
    const envelopeSucceeded = await this.executeLocked('gridflex:worker:staleness', 'envelope-staleness', () =>
      this.maintenance.markStaleEnvelopes(),
    );
    const passportSucceeded = await this.executeLocked('gridflex:worker:passport-staleness', 'passport-staleness', () =>
      this.maintenance.propagatePassportStaleness(),
    );
    return envelopeSucceeded && passportSucceeded;
  }

  @Cron('0 7 * * * *', {
    name: 'envelope-recompute',
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  async envelopeScheduled(): Promise<boolean> {
    return this.executeLocked('gridflex:worker:envelope-recompute', 'envelope-recompute', () =>
      this.envelope.run(),
    );
  }

  @Cron('0 17 * * * *', {
    name: 'idempotency-cleanup',
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  async idempotencyScheduled(): Promise<boolean> {
    return this.executeLocked('gridflex:worker:idempotency-cleanup', 'idempotency-cleanup', () =>
      this.maintenance.cleanupIdempotencyKeys(),
    );
  }

  @Cron('0 23 2 * * *', {
    name: 'export-cleanup',
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  async exportCleanupScheduled(): Promise<boolean> {
    return this.executeLocked('gridflex:worker:export-cleanup', 'export-cleanup', () =>
      this.maintenance.cleanupExports(),
    );
  }

  /** Deterministic deployment smoke command: WORKER_RUN_ONCE=true pnpm ... start. */
  async runOnce(): Promise<void> {
    const outcomes = [
      await this.execute('heartbeat', () => this.heartbeat.run()),
      await this.simulatorScheduled(),
      await this.telemetryQualityScheduled(),
      await this.stalenessScheduled(),
      await this.envelopeScheduled(),
      await this.idempotencyScheduled(),
      await this.exportCleanupScheduled(),
    ];
    if (outcomes.some((outcome) => !outcome)) {
      throw new Error('One or more one-shot worker jobs failed');
    }
  }

  private async executeLocked<T extends JobResult>(
    lockName: string,
    jobName: string,
    task: () => Promise<T>,
  ): Promise<boolean> {
    return this.execute(jobName, async () => {
      const result = await this.locks.run(lockName, task);
      if (!result.acquired) return { skipped: 'lock-held' };
      return result.value ?? {};
    });
  }

  private async execute<T extends JobResult>(jobName: string, task: () => Promise<T>): Promise<boolean> {
    const startedAt = Date.now();
    try {
      const result = await task();
      this.logger.info(
        { job: jobName, duration_ms: Date.now() - startedAt, result },
        'worker job completed',
      );
      return true;
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      this.logger.error(
        { job: jobName, duration_ms: Date.now() - startedAt, error_name: errorName },
        'worker job failed',
      );
      return false;
    }
  }
}
