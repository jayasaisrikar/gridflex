import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) process.exit(1);

const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3_000 });
try {
  await client.connect();
  const result = await client.query<{ healthy: boolean }>(
    `select coalesce(max(last_seen_at) >= now() - interval '90 seconds', false) as healthy
     from service_heartbeats where service_name = 'worker'`,
  );
  process.exitCode = result.rows[0]?.healthy === true ? 0 : 1;
} catch {
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
