/**
 * Drizzle table definitions mirroring infra/sql/gridflex_schema.sql.
 *
 * The SQL migration is authoritative (spec 7). These definitions exist for typed
 * query building and MUST match the SQL exactly — same table names, column names,
 * enum labels, and nullability. `scripts/check-schema.ts` asserts the live database
 * agrees with this file; a drift there is a build failure, not a warning.
 *
 * numeric/bigint columns are typed as `string` on purpose (see client.ts).
 */
import {
  bigint,
  bigserial,
  boolean,
  char,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** citext — case-insensitive text, provided by the citext extension. */
const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

/** inet — IP address column type. */
const inet = customType<{ data: string }>({
  dataType: () => 'inet',
});

/** bytea — raw bytes, used for encrypted connector configuration. */
const bytea = customType<{ data: Buffer }>({
  dataType: () => 'bytea',
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRole = pgEnum('user_role', [
  'OWNER',
  'FACILITY_ADMIN',
  'OPS_ENGINEER',
  'REVIEWER',
  'VIEWER',
]);

export const connectorType = pgEnum('connector_type', [
  'CSV_UPLOAD',
  'INTERVAL_METER_API',
  'DCIM_API',
  'BMS_API',
  'MODBUS_EXPORT',
  'BACNET_EXPORT',
  'SCHEDULER_API',
  'SIMULATOR',
]);

export const connectorStatus = pgEnum('connector_status', [
  'DRAFT',
  'ACTIVE',
  'DEGRADED',
  'ERROR',
  'DISABLED',
]);

export const syncStatus = pgEnum('sync_status', [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
]);

export const telemetryQuality = pgEnum('telemetry_quality', [
  'GOOD',
  'ESTIMATED',
  'SUSPECT',
  'MISSING',
  'QUARANTINED',
]);

export const provenanceKind = pgEnum('provenance_kind', ['DECLARED', 'MODELED', 'TESTED']);

export const envelopeStatus = pgEnum('envelope_status', [
  'DRAFT',
  'CURRENT',
  'STALE',
  'SUPERSEDED',
  'BLOCKED',
]);

export const drillStatus = pgEnum('drill_status', [
  'DRAFT',
  'READY',
  'ARMED',
  'RUNNING',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'ABORTED',
  'CANCELLED',
]);

export const drillEventType = pgEnum('drill_event_type', [
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
]);

export const engineRunStatus = pgEnum('engine_run_status', [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
]);

export const passportStatus = pgEnum('passport_status', [
  'DRAFT',
  'ISSUED',
  'SUPERSEDED',
  'REVOKED',
]);

export const exportStatus = pgEnum('export_status', [
  'QUEUED',
  'GENERATING',
  'READY',
  'FAILED',
  'EXPIRED',
]);

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const money = (name: string) => numeric(name, { precision: 14, scale: 3 });
const ratio = (name: string) => numeric(name, { precision: 5, scale: 4 });
const now = sql`now()`;
const emptyObject = sql`'{}'::jsonb`;
const emptyArray = sql`'[]'::jsonb`;

// ---------------------------------------------------------------------------
// Identity, tenancy, sessions
// ---------------------------------------------------------------------------

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  slug: citext('slug').notNull().unique(),
  createdAt: tz('created_at').notNull().default(now),
  updatedAt: tz('updated_at').notNull().default(now),
});

export const appUsers = pgTable('app_users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  email: citext('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  lastLoginAt: tz('last_login_at'),
  createdAt: tz('created_at').notNull().default(now),
  updatedAt: tz('updated_at').notNull().default(now),
});

export const authRefreshTokens = pgTable(
  'auth_refresh_tokens',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
    expiresAt: tz('expires_at').notNull(),
    revokedAt: tz('revoked_at'),
    replacedByTokenId: uuid('replaced_by_token_id'),
    createdIp: inet('created_ip'),
    userAgent: text('user_agent'),
    createdAt: tz('created_at').notNull().default(now),
  },
  (table) => [
    index('idx_refresh_tokens_user_active')
      .on(table.userId, table.expiresAt.desc())
      .where(sql`revoked_at IS NULL`),
    index('idx_refresh_tokens_family').on(table.familyId),
  ],
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    role: userRole('role').notNull(),
    createdAt: tz('created_at').notNull().default(now),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })],
);

// ---------------------------------------------------------------------------
// Facilities and capability
// ---------------------------------------------------------------------------

export const facilities = pgTable(
  'facilities',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: citext('slug').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    countryCode: char('country_code', { length: 2 }),
    region: text('region'),
    market: text('market'),
    normalLoadKw: money('normal_load_kw'),
    minimumSafeLoadKw: money('minimum_safe_load_kw'),
    maximumCurtailmentKw: money('maximum_curtailment_kw'),
    rampRateKwPerMin: money('ramp_rate_kw_per_min'),
    coolingReserveKw: money('cooling_reserve_kw'),
    status: text('status').notNull().default('ACTIVE'),
    metadata: jsonb('metadata').notNull().default(emptyObject),
    createdAt: tz('created_at').notNull().default(now),
    updatedAt: tz('updated_at').notNull().default(now),
  },
  (table) => [unique().on(table.organizationId, table.slug)],
);

export const facilityConstraints = pgTable(
  'facility_constraints',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    effectiveFrom: tz('effective_from').notNull().default(now),
    effectiveTo: tz('effective_to'),
    minimumSafeLoadKw: money('minimum_safe_load_kw').notNull(),
    maximumCurtailmentKw: money('maximum_curtailment_kw').notNull(),
    maximumRampKwPerMin: money('maximum_ramp_kw_per_min').notNull(),
    maximumDurationMin: integer('maximum_duration_min').notNull(),
    minimumRecoveryMin: integer('minimum_recovery_min').notNull().default(0),
    maximumReboundKw: money('maximum_rebound_kw'),
    thermalLimitC: numeric('thermal_limit_c', { precision: 8, scale: 3 }),
    excludedWorkloads: jsonb('excluded_workloads').notNull().default(emptyArray),
    tenantCarveOuts: jsonb('tenant_carve_outs').notNull().default(emptyArray),
    sourceNote: text('source_note'),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: tz('created_at').notNull().default(now),
  },
  (table) => [unique().on(table.facilityId, table.version)],
);

export const flexibilityMechanisms = pgTable(
  'flexibility_mechanisms',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    mechanismType: text('mechanism_type').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    declaredReducibleKw: money('declared_reducible_kw'),
    minimumLoadKw: money('minimum_load_kw'),
    rampRateKwPerMin: money('ramp_rate_kw_per_min'),
    maximumDurationMin: integer('maximum_duration_min'),
    reboundWindowMin: integer('rebound_window_min'),
    controlReference: text('control_reference'),
    metadata: jsonb('metadata').notNull().default(emptyObject),
    createdAt: tz('created_at').notNull().default(now),
    updatedAt: tz('updated_at').notNull().default(now),
  },
  (table) => [unique().on(table.facilityId, table.code)],
);

// ---------------------------------------------------------------------------
// Data acquisition
// ---------------------------------------------------------------------------

export const connectors = pgTable('connectors', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  facilityId: uuid('facility_id')
    .notNull()
    .references(() => facilities.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  connectorType: connectorType('connector_type').notNull(),
  status: connectorStatus('status').notNull().default('DRAFT'),
  /** AES-GCM ciphertext under CONNECTOR_ENCRYPTION_KEY. Never logged or returned by the API. */
  configurationEncrypted: bytea('configuration_encrypted'),
  configSummary: jsonb('config_summary').notNull().default(emptyObject),
  pollIntervalSeconds: integer('poll_interval_seconds'),
  lastSyncAt: tz('last_sync_at'),
  lastSuccessAt: tz('last_success_at'),
  lastError: text('last_error'),
  createdBy: uuid('created_by').references(() => appUsers.id),
  createdAt: tz('created_at').notNull().default(now),
  updatedAt: tz('updated_at').notNull().default(now),
});

export const connectorSyncRuns = pgTable('connector_sync_runs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  connectorId: uuid('connector_id')
    .notNull()
    .references(() => connectors.id, { onDelete: 'cascade' }),
  status: syncStatus('status').notNull().default('QUEUED'),
  startedAt: tz('started_at'),
  finishedAt: tz('finished_at'),
  sourceWindowStart: tz('source_window_start'),
  sourceWindowEnd: tz('source_window_end'),
  rowsSeen: integer('rows_seen').notNull().default(0),
  rowsInserted: integer('rows_inserted').notNull().default(0),
  rowsQuarantined: integer('rows_quarantined').notNull().default(0),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  metadata: jsonb('metadata').notNull().default(emptyObject),
  createdAt: tz('created_at').notNull().default(now),
});

/** APPEND-ONLY. A database trigger rejects UPDATE and DELETE (spec 7.2). */
export const telemetryReadings = pgTable(
  'telemetry_readings',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'cascade' }),
    connectorId: uuid('connector_id').references(() => connectors.id, { onDelete: 'set null' }),
    sourceKey: text('source_key').notNull(),
    metricKey: text('metric_key').notNull(),
    measuredAt: tz('measured_at').notNull(),
    // double precision in SQL. Raw telemetry is a physical measurement, not an
    // accounting quantity; exactness is introduced downstream in the MRV engine,
    // which sums into integer Wh (spec 14).
    valueDouble: doublePrecision('value_double').notNull(),
    unit: text('unit').notNull(),
    quality: telemetryQuality('quality').notNull().default('GOOD'),
    sourceSequence: text('source_sequence'),
    ingestRunId: uuid('ingest_run_id').references(() => connectorSyncRuns.id, {
      onDelete: 'set null',
    }),
    metadata: jsonb('metadata').notNull().default(emptyObject),
    ingestedAt: tz('ingested_at').notNull().default(now),
  },
  (table) => [
    // Backs idempotent batch ingestion (spec 9.2).
    unique().on(table.facilityId, table.sourceKey, table.metricKey, table.measuredAt),
    index('idx_telemetry_facility_metric_time').on(
      table.facilityId,
      table.metricKey,
      table.measuredAt.desc(),
    ),
    index('idx_telemetry_facility_time').on(table.facilityId, table.measuredAt.desc()),
    index('idx_telemetry_measured_brin').using('brin', table.measuredAt),
  ],
);

export const telemetryQuarantine = pgTable('telemetry_quarantine', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'cascade' }),
  connectorId: uuid('connector_id').references(() => connectors.id, { onDelete: 'set null' }),
  ingestRunId: uuid('ingest_run_id').references(() => connectorSyncRuns.id, {
    onDelete: 'set null',
  }),
  receivedAt: tz('received_at').notNull().default(now),
  rawPayload: jsonb('raw_payload').notNull(),
  reasonCode: text('reason_code').notNull(),
  reasonDetail: text('reason_detail'),
  resolvedAt: tz('resolved_at'),
  resolvedBy: uuid('resolved_by').references(() => appUsers.id),
});

// ---------------------------------------------------------------------------
// Assurance engine
// ---------------------------------------------------------------------------

export const engineRuns = pgTable('engine_runs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'cascade' }),
  runType: text('run_type').notNull(),
  status: engineRunStatus('status').notNull().default('QUEUED'),
  inputRef: jsonb('input_ref').notNull().default(emptyObject),
  outputRef: jsonb('output_ref').notNull().default(emptyObject),
  methodologyVersion: text('methodology_version'),
  startedAt: tz('started_at'),
  finishedAt: tz('finished_at'),
  errorCode: text('error_code'),
  errorDetail: text('error_detail'),
  createdAt: tz('created_at').notNull().default(now),
});

export const envelopes = pgTable(
  'envelopes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: envelopeStatus('status').notNull().default('DRAFT'),
    asOf: tz('as_of').notNull(),
    validUntil: tz('valid_until'),
    totalReducibleKw: money('total_reducible_kw').notNull(),
    responseTimeSeconds: integer('response_time_seconds').notNull(),
    sustainableDurationMin: integer('sustainable_duration_min').notNull(),
    aggregateRampKwPerMin: money('aggregate_ramp_kw_per_min').notNull(),
    reboundPeakKw: money('rebound_peak_kw'),
    reboundDurationMin: integer('rebound_duration_min'),
    confidenceScore: ratio('confidence_score').notNull(),
    telemetryCompleteness: ratio('telemetry_completeness').notNull(),
    methodologyVersion: text('methodology_version').notNull(),
    constraintsVersion: integer('constraints_version').notNull(),
    blockedReasons: jsonb('blocked_reasons').notNull().default(emptyArray),
    summary: jsonb('summary').notNull().default(emptyObject),
    createdByEngineRun: uuid('created_by_engine_run').references(() => engineRuns.id, {
      onDelete: 'set null',
    }),
    createdAt: tz('created_at').notNull().default(now),
  },
  (table) => [unique().on(table.facilityId, table.version)],
);

export const envelopeMechanisms = pgTable(
  'envelope_mechanisms',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    envelopeId: uuid('envelope_id')
      .notNull()
      .references(() => envelopes.id, { onDelete: 'cascade' }),
    mechanismId: uuid('mechanism_id')
      .notNull()
      .references(() => flexibilityMechanisms.id, { onDelete: 'restrict' }),
    provenance: provenanceKind('provenance').notNull(),
    reducibleKw: money('reducible_kw').notNull(),
    responseTimeSeconds: integer('response_time_seconds').notNull(),
    rampKwPerMin: money('ramp_kw_per_min').notNull(),
    durationMin: integer('duration_min').notNull(),
    reboundPeakKw: money('rebound_peak_kw'),
    reboundDurationMin: integer('rebound_duration_min'),
    confidenceScore: ratio('confidence_score').notNull(),
    evidenceRefs: jsonb('evidence_refs').notNull().default(emptyArray),
    notes: text('notes'),
  },
  (table) => [unique().on(table.envelopeId, table.mechanismId)],
);

export const engineDecisions = pgTable('engine_decisions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  engineRunId: uuid('engine_run_id')
    .notNull()
    .references(() => engineRuns.id, { onDelete: 'cascade' }),
  decisionType: text('decision_type').notNull(),
  decisionCode: text('decision_code').notNull(),
  severity: text('severity').notNull(),
  facts: jsonb('facts').notNull(),
  rulesEvaluated: jsonb('rules_evaluated').notNull().default(emptyArray),
  createdAt: tz('created_at').notNull().default(now),
});

// ---------------------------------------------------------------------------
// Drills and proof
// ---------------------------------------------------------------------------

export const drills = pgTable('drills', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  facilityId: uuid('facility_id')
    .notNull()
    .references(() => facilities.id, { onDelete: 'cascade' }),
  envelopeId: uuid('envelope_id').references(() => envelopes.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  status: drillStatus('status').notNull().default('DRAFT'),
  requestedReductionKw: money('requested_reduction_kw').notNull(),
  plannedStartAt: tz('planned_start_at').notNull(),
  plannedEndAt: tz('planned_end_at').notNull(),
  baselineWindowStart: tz('baseline_window_start'),
  baselineMethod: text('baseline_method').notNull().default('MEDIAN_SAME_INTERVAL_5_DAYS'),
  maximumRampKwPerMin: money('maximum_ramp_kw_per_min'),
  minimumSafeLoadKw: money('minimum_safe_load_kw'),
  operatorNotes: text('operator_notes'),
  simulationMode: boolean('simulation_mode').notNull().default(false),
  replayMode: boolean('replay_mode').notNull().default(false),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => appUsers.id),
  armedBy: uuid('armed_by').references(() => appUsers.id),
  armedAt: tz('armed_at'),
  startedAt: tz('started_at'),
  endedAt: tz('ended_at'),
  abortReasonCode: text('abort_reason_code'),
  abortReasonDetail: text('abort_reason_detail'),
  createdAt: tz('created_at').notNull().default(now),
  updatedAt: tz('updated_at').notNull().default(now),
});

export const drillArmChallenges = pgTable(
  'drill_arm_challenges',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    drillId: uuid('drill_id')
      .notNull()
      .references(() => drills.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    challengeHash: char('challenge_hash', { length: 64 }).notNull().unique(),
    expectedConfirmationHash: char('expected_confirmation_hash', { length: 64 }).notNull(),
    constraintSnapshot: jsonb('constraint_snapshot').notNull(),
    expiresAt: tz('expires_at').notNull(),
    consumedAt: tz('consumed_at'),
    createdAt: tz('created_at').notNull().default(now),
  },
  (table) => [index('idx_arm_challenges_drill_expiry').on(table.drillId, table.expiresAt.desc())],
);

/** APPEND-ONLY. A database trigger rejects UPDATE and DELETE (spec 7.2). */
export const drillEvents = pgTable(
  'drill_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    drillId: uuid('drill_id')
      .notNull()
      .references(() => drills.id, { onDelete: 'cascade' }),
    eventType: drillEventType('event_type').notNull(),
    occurredAt: tz('occurred_at').notNull().default(now),
    actorUserId: uuid('actor_user_id').references(() => appUsers.id),
    actorService: text('actor_service'),
    reasonCode: text('reason_code'),
    payload: jsonb('payload').notNull().default(emptyObject),
    correlationId: uuid('correlation_id').notNull().default(sql`gen_random_uuid()`),
  },
  (table) => [index('idx_drill_events_drill_time').on(table.drillId, table.occurredAt)],
);

export const mrvReports = pgTable('mrv_reports', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  drillId: uuid('drill_id')
    .notNull()
    .unique()
    .references(() => drills.id, { onDelete: 'cascade' }),
  methodologyVersion: text('methodology_version').notNull(),
  intervalSeconds: integer('interval_seconds').notNull(),
  committedEnergyWh: bigint('committed_energy_wh', { mode: 'bigint' }).notNull(),
  deliveredEnergyWh: bigint('delivered_energy_wh', { mode: 'bigint' }).notNull(),
  averageDeliveredKw: money('average_delivered_kw').notNull(),
  performanceBps: integer('performance_bps').notNull(),
  telemetryCompleteness: ratio('telemetry_completeness').notNull(),
  maximumGapIntervals: integer('maximum_gap_intervals').notNull().default(0),
  baselineSeries: jsonb('baseline_series').notNull(),
  actualSeries: jsonb('actual_series').notNull(),
  qualityBlocks: jsonb('quality_blocks').notNull().default(emptyArray),
  reboundEnergyWh: bigint('rebound_energy_wh', { mode: 'bigint' }),
  generatedByEngineRun: uuid('generated_by_engine_run').references(() => engineRuns.id, {
    onDelete: 'set null',
  }),
  generatedAt: tz('generated_at').notNull().default(now),
});

/** APPEND-ONLY. A database trigger rejects UPDATE and DELETE (spec 7.2). */
export const evidenceBundles = pgTable('evidence_bundles', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  facilityId: uuid('facility_id')
    .notNull()
    .references(() => facilities.id, { onDelete: 'cascade' }),
  drillId: uuid('drill_id').references(() => drills.id, { onDelete: 'set null' }),
  mrvReportId: uuid('mrv_report_id').references(() => mrvReports.id, { onDelete: 'set null' }),
  schemaVersion: text('schema_version').notNull(),
  canonicalJson: jsonb('canonical_json').notNull(),
  canonicalSha256: char('canonical_sha256', { length: 64 }).notNull().unique(),
  storageUri: text('storage_uri'),
  signatureAlgorithm: text('signature_algorithm'),
  signatureValue: text('signature_value'),
  signedBy: text('signed_by'),
  createdAt: tz('created_at').notNull().default(now),
});

export const passports = pgTable(
  'passports',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'cascade' }),
    envelopeId: uuid('envelope_id')
      .notNull()
      .references(() => envelopes.id, { onDelete: 'restrict' }),
    evidenceBundleId: uuid('evidence_bundle_id')
      .notNull()
      .references(() => evidenceBundles.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    status: passportStatus('status').notNull().default('DRAFT'),
    passportJson: jsonb('passport_json').notNull(),
    passportSha256: char('passport_sha256', { length: 64 }).notNull().unique(),
    pdfStorageUri: text('pdf_storage_uri'),
    issuedAt: tz('issued_at'),
    issuedBy: uuid('issued_by').references(() => appUsers.id),
    supersededBy: uuid('superseded_by'),
    revocationReason: text('revocation_reason'),
    createdAt: tz('created_at').notNull().default(now),
  },
  (table) => [unique().on(table.facilityId, table.version)],
);

export const exportPackages = pgTable('export_packages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  facilityId: uuid('facility_id')
    .notNull()
    .references(() => facilities.id, { onDelete: 'cascade' }),
  passportId: uuid('passport_id')
    .notNull()
    .references(() => passports.id, { onDelete: 'cascade' }),
  counterpartyName: text('counterparty_name'),
  formatCode: text('format_code').notNull(),
  status: exportStatus('status').notNull().default('QUEUED'),
  storageUri: text('storage_uri'),
  expiresAt: tz('expires_at'),
  errorDetail: text('error_detail'),
  requestedBy: uuid('requested_by').references(() => appUsers.id),
  createdAt: tz('created_at').notNull().default(now),
  completedAt: tz('completed_at'),
});

// ---------------------------------------------------------------------------
// Safety and governance
// ---------------------------------------------------------------------------

export const emergencyStopEvents = pgTable('emergency_stop_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  facilityId: uuid('facility_id')
    .notNull()
    .references(() => facilities.id, { onDelete: 'cascade' }),
  drillId: uuid('drill_id').references(() => drills.id, { onDelete: 'set null' }),
  activatedBy: uuid('activated_by').references(() => appUsers.id),
  activatedAt: tz('activated_at').notNull().default(now),
  reasonCode: text('reason_code').notNull(),
  reasonDetail: text('reason_detail'),
  clearedBy: uuid('cleared_by').references(() => appUsers.id),
  clearedAt: tz('cleared_at'),
  clearNote: text('clear_note'),
});

/** APPEND-ONLY. A database trigger rejects UPDATE and DELETE (spec 7.2). */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'set null' }),
    actorUserId: uuid('actor_user_id').references(() => appUsers.id, { onDelete: 'set null' }),
    actorService: text('actor_service'),
    action: text('action').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id'),
    beforeState: jsonb('before_state'),
    afterState: jsonb('after_state'),
    requestId: uuid('request_id'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: tz('created_at').notNull().default(now),
  },
  (table) => [index('idx_audit_org_created').on(table.organizationId, table.createdAt.desc())],
);

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  scope: text('scope').notNull(),
  requestHash: char('request_hash', { length: 64 }).notNull(),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  expiresAt: tz('expires_at').notNull(),
  createdAt: tz('created_at').notNull().default(now),
});

export const serviceHeartbeats = pgTable('service_heartbeats', {
  serviceName: text('service_name').primaryKey(),
  instanceId: text('instance_id').notNull(),
  lastSeenAt: tz('last_seen_at').notNull().default(now),
  metadata: jsonb('metadata').notNull().default(emptyObject),
});

/** Tables protected by the reject_mutation() trigger. Asserted by integration tests. */
export const APPEND_ONLY_TABLES = [
  'telemetry_readings',
  'drill_events',
  'evidence_bundles',
  'audit_logs',
] as const;
