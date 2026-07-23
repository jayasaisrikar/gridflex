import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';
import { WORKER_LOGGER, WORKER_SETTINGS, type WorkerLogger, type WorkerSettings } from './runtime.js';
import { WorkerJobsService } from './jobs/worker-jobs.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  app.enableShutdownHooks();

  const logger = app.get<WorkerLogger>(WORKER_LOGGER);
  const settings = app.get<WorkerSettings>(WORKER_SETTINGS);

  logger.info(
    {
      instance_id: process.env.WORKER_INSTANCE_ID ?? 'worker-local',
      mode: settings.runOnce ? 'one-shot' : 'scheduled',
    },
    'worker started',
  );

  if (settings.runOnce) {
    const jobs = app.get(WorkerJobsService);
    try {
      await jobs.runOnce();
      logger.info('one-shot worker run completed');
    } finally {
      await app.close();
    }
  }
}

bootstrap().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  // Do not print error.message here: startup failures can include a connection URL.
  process.stderr.write(`GridFlex worker failed to start (${errorName}).\n`);
  process.exitCode = 1;
});
