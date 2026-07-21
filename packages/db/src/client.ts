import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool, types } = pg;

/**
 * Precision discipline (spec 6.1): PostgreSQL `numeric` must NOT be coerced to a
 * JavaScript number — 14,3 values and bigint Wh totals lose exactness. We return
 * them as strings and convert deliberately inside the engine's calculation code.
 */
const PG_NUMERIC_OID = 1700;
const PG_INT8_OID = 20;
types.setTypeParser(PG_NUMERIC_OID, (value: string) => value);
types.setTypeParser(PG_INT8_OID, (value: string) => value);

export type Database = NodePgDatabase<typeof schema>;

export interface PoolOptions {
  connectionString: string;
  max?: number;
  statementTimeoutMs?: number;
}

/**
 * One pool per process — never per request (spec 7.4).
 */
export function createPool(options: PoolOptions): pg.Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // Ordinary request connections get a 30s statement timeout. Long-running export
  // jobs opt into a higher timeout explicitly on their own connection.
  const statementTimeoutMs = options.statementTimeoutMs ?? 30_000;
  pool.on('connect', (client) => {
    void client.query(`SET statement_timeout = ${statementTimeoutMs}`);
  });

  return pool;
}

export function createDatabase(pool: pg.Pool): Database {
  return drizzle({ client: pool, schema });
}

export { schema };
