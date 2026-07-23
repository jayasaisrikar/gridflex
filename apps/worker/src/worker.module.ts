import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { createLogger } from '@gridflex/config/logger';
import { parseEnv, workerEnvSchema } from '@gridflex/config/env';
import { createDatabase, createPool } from '@gridflex/db/client';
import {
  WORKER_DATABASE,
  WORKER_ENV,
  WORKER_LOGGER,
  WORKER_POOL,
  WORKER_SETTINGS,
  parseWorkerSettings,
  type WorkerPool,
} from './runtime.js';
import { AdvisoryLockService } from './jobs/advisory-lock.service.js';
import { EnvelopeJob } from './jobs/envelope.job.js';
import { HeartbeatJob } from './jobs/heartbeat.job.js';
import { MaintenanceJob } from './jobs/maintenance.job.js';
import { SimulatorJob } from './jobs/simulator.job.js';
import { WorkerJobsService } from './jobs/worker-jobs.service.js';

@Injectable()
class PoolShutdown implements OnApplicationShutdown {
  constructor(@Inject(WORKER_POOL) private readonly pool: WorkerPool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [
    {
      provide: WORKER_ENV,
      useFactory: () => parseEnv(workerEnvSchema),
    },
    {
      provide: WORKER_SETTINGS,
      useFactory: () => parseWorkerSettings(),
    },
    {
      provide: WORKER_LOGGER,
      inject: [WORKER_ENV],
      useFactory: (env: ReturnType<typeof workerEnvSchema.parse>) =>
        createLogger({ name: 'gridflex-worker', level: env.LOG_LEVEL ?? 'info' }),
    },
    {
      provide: WORKER_POOL,
      inject: [WORKER_ENV],
      useFactory: (env: ReturnType<typeof workerEnvSchema.parse>) =>
        createPool({ connectionString: env.DATABASE_URL, max: 6 }),
    },
    {
      provide: WORKER_DATABASE,
      inject: [WORKER_POOL],
      useFactory: (pool: WorkerPool) => createDatabase(pool),
    },
    PoolShutdown,
    AdvisoryLockService,
    EnvelopeJob,
    HeartbeatJob,
    MaintenanceJob,
    SimulatorJob,
    WorkerJobsService,
  ],
  exports: [WorkerJobsService, WORKER_LOGGER, WORKER_SETTINGS],
})
export class WorkerModule {}
