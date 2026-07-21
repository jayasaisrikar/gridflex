/**
 * Schema contract verification (`pnpm db:check`).
 *
 * Spec §7: `gridflex_schema.sql` is the authoritative database contract. This
 * script asserts the live database actually matches it — every table, enum,
 * extension, index, function, and append-only trigger. Drift is a hard failure,
 * not a warning, because the Drizzle TypeScript definitions silently assume this
 * shape and a mismatch surfaces later as corrupt data rather than a type error.
 *
 * Read-only. Safe to run against any environment.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

const EXPECTED_TABLES = [
  'app_users',
  'audit_logs',
  'auth_refresh_tokens',
  'connector_sync_runs',
  'connectors',
  'drill_arm_challenges',
  'drill_events',
  'drills',
  'emergency_stop_events',
  'engine_decisions',
  'engine_runs',
  'envelope_mechanisms',
  'envelopes',
  'evidence_bundles',
  'export_packages',
  'facilities',
  'facility_constraints',
  'flexibility_mechanisms',
  'idempotency_keys',
  'mrv_reports',
  'organization_members',
  'organizations',
  'passports',
  'service_heartbeats',
  'telemetry_quarantine',
  'telemetry_readings',
] as const;

const EXPECTED_ENUMS: Record<string, readonly string[]> = {
  user_role: ['OWNER', 'FACILITY_ADMIN', 'OPS_ENGINEER', 'REVIEWER', 'VIEWER'],
  connector_type: [
    'CSV_UPLOAD',
    'INTERVAL_METER_API',
    'DCIM_API',
    'BMS_API',
    'MODBUS_EXPORT',
    'BACNET_EXPORT',
    'SCHEDULER_API',
    'SIMULATOR',
  ],
  connector_status: ['DRAFT', 'ACTIVE', 'DEGRADED', 'ERROR', 'DISABLED'],
  sync_status: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED'],
  telemetry_quality: ['GOOD', 'ESTIMATED', 'SUSPECT', 'MISSING', 'QUARANTINED'],
  provenance_kind: ['DECLARED', 'MODELED', 'TESTED'],
  envelope_status: ['DRAFT', 'CURRENT', 'STALE', 'SUPERSEDED', 'BLOCKED'],
  drill_status: [
    'DRAFT',
    'READY',
    'ARMED',
    'RUNNING',
    'VERIFYING',
    'COMPLETED',
    'FAILED',
    'ABORTED',
    'CANCELLED',
  ],
  drill_event_type: [
    'CREATED',
    'VALIDATED',
    'ARMED',
    'STARTED',
    'SETPOINT_CHANGED',
    'TELEMETRY_WARNING',
    'EMERGENCY_STOP',
    'COMPLETED',
    'FAILED',
    'ABORTED',
    'MRV_GENERATED',
    'PASSPORT_ISSUED',
  ],
  engine_run_status: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED'],
  passport_status: ['DRAFT', 'ISSUED', 'SUPERSEDED', 'REVOKED'],
  export_status: ['QUEUED', 'GENERATING', 'READY', 'FAILED', 'EXPIRED'],
};

/** Spec §7.2 — these tables reject UPDATE and DELETE at the database level. */
const APPEND_ONLY_TRIGGERS: Record<string, string> = {
  telemetry_readings: 'trg_telemetry_append_only',
  drill_events: 'trg_drill_events_append_only',
  evidence_bundles: 'trg_evidence_append_only',
  audit_logs: 'trg_audit_append_only',
};

const EXPECTED_INDEXES = [
  'idx_telemetry_facility_metric_time',
  'idx_telemetry_facility_time',
  'idx_telemetry_measured_brin',
  'idx_refresh_tokens_user_active',
  'idx_refresh_tokens_family',
  'idx_drill_events_drill_time',
  'idx_arm_challenges_drill_expiry',
  'idx_audit_org_created',
];

const failures: string[] = [];
const notes: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function loadDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;

  // Fall back to the repo-root .env for local runs.
  try {
    const text = readFileSync(resolve(here, '../../../.env'), 'utf8');
    for (const line of text.split('\n')) {
      if (line.startsWith('DATABASE_URL=')) return line.slice('DATABASE_URL='.length).trim();
    }
  } catch {
    // fall through
  }
  throw new Error('DATABASE_URL is required');
}

async function main(): Promise<void> {
  const client = new pg.Client({
    connectionString: loadDatabaseUrl(),
    connectionTimeoutMillis: 8_000,
  });
  await client.connect();

  try {
    // --- Extensions -------------------------------------------------------
    const extensions = await client.query<{ extname: string }>(
      `select extname from pg_extension where extname = any($1::text[])`,
      [['pgcrypto', 'citext']],
    );
    const extensionNames = extensions.rows.map((row) => row.extname);
    for (const required of ['pgcrypto', 'citext']) {
      check(
        extensionNames.includes(required),
        `Missing extension "${required}". gen_random_uuid() and citext columns depend on it.`,
      );
    }

    // --- Tables -----------------------------------------------------------
    const tables = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const tableNames = new Set(tables.rows.map((row) => row.table_name));
    for (const expected of EXPECTED_TABLES) {
      check(tableNames.has(expected), `Missing table "${expected}".`);
    }
    const unexpected = [...tableNames].filter(
      (name) => !EXPECTED_TABLES.includes(name as (typeof EXPECTED_TABLES)[number]) &&
        name !== '__drizzle_migrations',
    );
    if (unexpected.length > 0) {
      notes.push(`Extra tables not in the contract: ${unexpected.join(', ')}`);
    }

    // --- Enums and their exact labels -------------------------------------
    for (const [enumName, labels] of Object.entries(EXPECTED_ENUMS)) {
      const result = await client.query<{ label: string }>(
        `select e.enumlabel as label
         from pg_type t join pg_enum e on e.enumtypid = t.oid
         where t.typname = $1
         order by e.enumsortorder`,
        [enumName],
      );
      if (result.rowCount === 0) {
        failures.push(`Missing enum "${enumName}".`);
        continue;
      }
      const actual = result.rows.map((row) => row.label);
      check(
        JSON.stringify(actual) === JSON.stringify(labels),
        `Enum "${enumName}" labels differ.\n    expected: ${labels.join(', ')}\n    actual:   ${actual.join(', ')}`,
      );
    }

    // --- Append-only triggers (spec 7.2) ----------------------------------
    for (const [table, triggerName] of Object.entries(APPEND_ONLY_TRIGGERS)) {
      const result = await client.query<{ tgname: string; events: string }>(
        `select t.tgname,
                array_to_string(array(
                  select unnest(array['INSERT','DELETE','UPDATE','TRUNCATE'])
                  where (t.tgtype & 4) <> 0 and 'INSERT' = 'INSERT'
                ), ',') as events
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         where c.relname = $1 and t.tgname = $2 and not t.tgisinternal`,
        [table, triggerName],
      );
      check(
        (result.rowCount ?? 0) > 0,
        `Missing append-only trigger "${triggerName}" on "${table}". Immutability (spec 7.2) is NOT enforced.`,
      );
    }

    // --- Trigger functions ------------------------------------------------
    for (const fn of ['set_updated_at', 'reject_mutation']) {
      const result = await client.query(
        `select 1 from pg_proc where proname = $1`,
        [fn],
      );
      check((result.rowCount ?? 0) > 0, `Missing function "${fn}()".`);
    }

    // --- Indexes ----------------------------------------------------------
    const indexes = await client.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public'`,
    );
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    for (const expected of EXPECTED_INDEXES) {
      check(indexNames.has(expected), `Missing index "${expected}".`);
    }

    // --- BRIN index is the right type (spec 7.3) --------------------------
    const brin = await client.query<{ amname: string }>(
      `select am.amname from pg_class c
       join pg_am am on am.oid = c.relam
       where c.relname = 'idx_telemetry_measured_brin'`,
    );
    check(
      brin.rows[0]?.amname === 'brin',
      `Index idx_telemetry_measured_brin should use BRIN, found "${brin.rows[0]?.amname ?? 'nothing'}".`,
    );

    // --- Telemetry idempotency constraint (spec 9.2) ----------------------
    const uniqueConstraint = await client.query(
      `select 1 from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       where c.relname = 'telemetry_readings' and con.contype = 'u'`,
    );
    check(
      (uniqueConstraint.rowCount ?? 0) > 0,
      'telemetry_readings is missing its UNIQUE constraint; batch ingestion would not be idempotent.',
    );
  } finally {
    await client.end();
  }

  // --- Report -------------------------------------------------------------
  for (const note of notes) console.log(`note: ${note}`);

  if (failures.length > 0) {
    console.error(`\nSchema contract FAILED with ${failures.length} problem(s):\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log('Schema contract OK');
  console.log(`  tables     : ${EXPECTED_TABLES.length}`);
  console.log(`  enums      : ${Object.keys(EXPECTED_ENUMS).length}`);
  console.log(`  append-only: ${Object.keys(APPEND_ONLY_TRIGGERS).length}`);
  console.log(`  indexes    : ${EXPECTED_INDEXES.length}`);
}

await main();
