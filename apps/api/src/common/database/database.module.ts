import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { createDatabase, createPool, type Database } from '@gridflex/db/client';
import type pg from 'pg';

export const DATABASE = Symbol('GRIDFLEX_DATABASE');
export const DATABASE_POOL = Symbol('GRIDFLEX_DATABASE_POOL');

/**
 * Database lifecycle (spec §7.4).
 *
 * One pool per process, created at boot and closed on shutdown — never one per
 * request. Connectivity is verified during startup so a misconfigured process
 * fails immediately and loudly rather than serving 500s.
 *
 * Migrations are NEVER run here (spec §6.1): `pnpm db:migrate` is a controlled
 * one-off deployment step executed before traffic is switched.
 */
@Injectable()
export class DatabaseLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(DATABASE_POOL) private readonly pool: pg.Pool) {}

  async onModuleInit(): Promise<void> {
    try {
      const result = await this.pool.query<{ ok: number }>('select 1 as ok');
      if (result.rows[0]?.ok !== 1) {
        throw new Error('Database connectivity check returned an unexpected result');
      }
    } catch (error) {
      // Deliberately does not include the connection string (spec §18).
      throw new Error(
        `Database is unreachable at startup: ${(error as Error).message.replace(/postgres(ql)?:\/\/\S+/gi, '[redacted]')}`,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      useFactory: (): pg.Pool => {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) throw new Error('DATABASE_URL is required');
        return createPool({ connectionString });
      },
    },
    {
      provide: DATABASE,
      inject: [DATABASE_POOL],
      useFactory: (pool: pg.Pool): Database => createDatabase(pool),
    },
    DatabaseLifecycle,
  ],
  exports: [DATABASE, DATABASE_POOL],
})
export class DatabaseModule {}
