-- GridFlex V2 initial schema
-- PostgreSQL 14+ compatible. PostgreSQL 16 recommended.
-- Source of truth for the reviewed initial Drizzle SQL migration.
-- Run with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f gridflex_schema.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('OWNER','FACILITY_ADMIN','OPS_ENGINEER','REVIEWER','VIEWER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE connector_type AS ENUM ('CSV_UPLOAD','INTERVAL_METER_API','DCIM_API','BMS_API','MODBUS_EXPORT','BACNET_EXPORT','SCHEDULER_API','SIMULATOR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE connector_status AS ENUM ('DRAFT','ACTIVE','DEGRADED','ERROR','DISABLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE sync_status AS ENUM ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE telemetry_quality AS ENUM ('GOOD','ESTIMATED','SUSPECT','MISSING','QUARANTINED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE provenance_kind AS ENUM ('DECLARED','MODELED','TESTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE envelope_status AS ENUM ('DRAFT','CURRENT','STALE','SUPERSEDED','BLOCKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE drill_status AS ENUM ('DRAFT','READY','ARMED','RUNNING','VERIFYING','COMPLETED','FAILED','ABORTED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE drill_event_type AS ENUM ('CREATED','VALIDATED','ARMED','STARTED','SETPOINT_CHANGED','TELEMETRY_WARNING','EMERGENCY_STOP','COMPLETED','FAILED','ABORTED','MRV_GENERATED','PASSPORT_ISSUED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE engine_run_status AS ENUM ('QUEUED','RUNNING','SUCCEEDED','FAILED','BLOCKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE passport_status AS ENUM ('DRAFT','ISSUED','SUPERSEDED','REVOKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE export_status AS ENUM ('QUEUED','GENERATING','READY','FAILED','EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    slug citext NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email citext NOT NULL UNIQUE,
    display_name text NOT NULL,
    password_hash text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    family_id uuid NOT NULL,
    token_hash char(64) NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    replaced_by_token_id uuid REFERENCES auth_refresh_tokens(id) ON DELETE SET NULL,
    created_ip inet,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active
    ON auth_refresh_tokens (user_id, expires_at DESC)
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family
    ON auth_refresh_tokens (family_id);

CREATE TABLE IF NOT EXISTS organization_members (
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    role user_role NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS facilities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name text NOT NULL,
    slug citext NOT NULL,
    timezone text NOT NULL DEFAULT 'UTC',
    country_code char(2),
    region text,
    market text,
    normal_load_kw numeric(14,3),
    minimum_safe_load_kw numeric(14,3),
    maximum_curtailment_kw numeric(14,3),
    ramp_rate_kw_per_min numeric(14,3),
    cooling_reserve_kw numeric(14,3),
    status text NOT NULL DEFAULT 'ACTIVE',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, slug),
    CHECK (normal_load_kw IS NULL OR normal_load_kw >= 0),
    CHECK (minimum_safe_load_kw IS NULL OR minimum_safe_load_kw >= 0),
    CHECK (maximum_curtailment_kw IS NULL OR maximum_curtailment_kw >= 0),
    CHECK (ramp_rate_kw_per_min IS NULL OR ramp_rate_kw_per_min > 0)
);

CREATE TABLE IF NOT EXISTS facility_constraints (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    version integer NOT NULL,
    effective_from timestamptz NOT NULL DEFAULT now(),
    effective_to timestamptz,
    minimum_safe_load_kw numeric(14,3) NOT NULL,
    maximum_curtailment_kw numeric(14,3) NOT NULL,
    maximum_ramp_kw_per_min numeric(14,3) NOT NULL,
    maximum_duration_min integer NOT NULL,
    minimum_recovery_min integer NOT NULL DEFAULT 0,
    maximum_rebound_kw numeric(14,3),
    thermal_limit_c numeric(8,3),
    excluded_workloads jsonb NOT NULL DEFAULT '[]'::jsonb,
    tenant_carve_outs jsonb NOT NULL DEFAULT '[]'::jsonb,
    source_note text,
    created_by uuid REFERENCES app_users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (facility_id, version),
    CHECK (maximum_duration_min > 0),
    CHECK (minimum_recovery_min >= 0)
);

CREATE TABLE IF NOT EXISTS flexibility_mechanisms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    code text NOT NULL,
    name text NOT NULL,
    description text,
    mechanism_type text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    declared_reducible_kw numeric(14,3),
    minimum_load_kw numeric(14,3),
    ramp_rate_kw_per_min numeric(14,3),
    maximum_duration_min integer,
    rebound_window_min integer,
    control_reference text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (facility_id, code)
);

CREATE TABLE IF NOT EXISTS connectors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    name text NOT NULL,
    connector_type connector_type NOT NULL,
    status connector_status NOT NULL DEFAULT 'DRAFT',
    configuration_encrypted bytea,
    config_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    poll_interval_seconds integer,
    last_sync_at timestamptz,
    last_success_at timestamptz,
    last_error text,
    created_by uuid REFERENCES app_users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (poll_interval_seconds IS NULL OR poll_interval_seconds >= 30)
);

CREATE TABLE IF NOT EXISTS connector_sync_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    status sync_status NOT NULL DEFAULT 'QUEUED',
    started_at timestamptz,
    finished_at timestamptz,
    source_window_start timestamptz,
    source_window_end timestamptz,
    rows_seen integer NOT NULL DEFAULT 0,
    rows_inserted integer NOT NULL DEFAULT 0,
    rows_quarantined integer NOT NULL DEFAULT 0,
    error_code text,
    error_message text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telemetry_readings (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    connector_id uuid REFERENCES connectors(id) ON DELETE SET NULL,
    source_key text NOT NULL,
    metric_key text NOT NULL,
    measured_at timestamptz NOT NULL,
    value_double double precision NOT NULL,
    unit text NOT NULL,
    quality telemetry_quality NOT NULL DEFAULT 'GOOD',
    source_sequence text,
    ingest_run_id uuid REFERENCES connector_sync_runs(id) ON DELETE SET NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (facility_id, source_key, metric_key, measured_at)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_facility_metric_time
    ON telemetry_readings (facility_id, metric_key, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_facility_time
    ON telemetry_readings (facility_id, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_measured_brin
    ON telemetry_readings USING brin (measured_at);

CREATE TABLE IF NOT EXISTS telemetry_quarantine (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    facility_id uuid REFERENCES facilities(id) ON DELETE CASCADE,
    connector_id uuid REFERENCES connectors(id) ON DELETE SET NULL,
    ingest_run_id uuid REFERENCES connector_sync_runs(id) ON DELETE SET NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    raw_payload jsonb NOT NULL,
    reason_code text NOT NULL,
    reason_detail text,
    resolved_at timestamptz,
    resolved_by uuid REFERENCES app_users(id)
);

CREATE TABLE IF NOT EXISTS envelopes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    version integer NOT NULL,
    status envelope_status NOT NULL DEFAULT 'DRAFT',
    as_of timestamptz NOT NULL,
    valid_until timestamptz,
    total_reducible_kw numeric(14,3) NOT NULL,
    response_time_seconds integer NOT NULL,
    sustainable_duration_min integer NOT NULL,
    aggregate_ramp_kw_per_min numeric(14,3) NOT NULL,
    rebound_peak_kw numeric(14,3),
    rebound_duration_min integer,
    confidence_score numeric(5,4) NOT NULL,
    telemetry_completeness numeric(5,4) NOT NULL,
    methodology_version text NOT NULL,
    constraints_version integer NOT NULL,
    blocked_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
    summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by_engine_run uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (facility_id, version),
    CHECK (confidence_score >= 0 AND confidence_score <= 1),
    CHECK (telemetry_completeness >= 0 AND telemetry_completeness <= 1)
);

CREATE TABLE IF NOT EXISTS envelope_mechanisms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    envelope_id uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
    mechanism_id uuid NOT NULL REFERENCES flexibility_mechanisms(id) ON DELETE RESTRICT,
    provenance provenance_kind NOT NULL,
    reducible_kw numeric(14,3) NOT NULL,
    response_time_seconds integer NOT NULL,
    ramp_kw_per_min numeric(14,3) NOT NULL,
    duration_min integer NOT NULL,
    rebound_peak_kw numeric(14,3),
    rebound_duration_min integer,
    confidence_score numeric(5,4) NOT NULL,
    evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
    notes text,
    UNIQUE (envelope_id, mechanism_id),
    CHECK (confidence_score >= 0 AND confidence_score <= 1)
);

CREATE TABLE IF NOT EXISTS drills (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    envelope_id uuid REFERENCES envelopes(id) ON DELETE SET NULL,
    name text NOT NULL,
    status drill_status NOT NULL DEFAULT 'DRAFT',
    requested_reduction_kw numeric(14,3) NOT NULL,
    planned_start_at timestamptz NOT NULL,
    planned_end_at timestamptz NOT NULL,
    baseline_window_start timestamptz,
    baseline_method text NOT NULL DEFAULT 'MEDIAN_SAME_INTERVAL_5_DAYS',
    maximum_ramp_kw_per_min numeric(14,3),
    minimum_safe_load_kw numeric(14,3),
    operator_notes text,
    simulation_mode boolean NOT NULL DEFAULT false,
    replay_mode boolean NOT NULL DEFAULT false,
    created_by uuid NOT NULL REFERENCES app_users(id),
    armed_by uuid REFERENCES app_users(id),
    armed_at timestamptz,
    started_at timestamptz,
    ended_at timestamptz,
    abort_reason_code text,
    abort_reason_detail text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (planned_end_at > planned_start_at),
    CHECK (requested_reduction_kw > 0)
);

CREATE TABLE IF NOT EXISTS drill_arm_challenges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    drill_id uuid NOT NULL REFERENCES drills(id) ON DELETE CASCADE,
    requested_by uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    challenge_hash char(64) NOT NULL UNIQUE,
    expected_confirmation_hash char(64) NOT NULL,
    constraint_snapshot jsonb NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_arm_challenges_drill_expiry
    ON drill_arm_challenges (drill_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS drill_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    drill_id uuid NOT NULL REFERENCES drills(id) ON DELETE CASCADE,
    event_type drill_event_type NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    actor_user_id uuid REFERENCES app_users(id),
    actor_service text,
    reason_code text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    correlation_id uuid NOT NULL DEFAULT gen_random_uuid()
);
CREATE INDEX IF NOT EXISTS idx_drill_events_drill_time ON drill_events (drill_id, occurred_at);

CREATE TABLE IF NOT EXISTS engine_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    facility_id uuid REFERENCES facilities(id) ON DELETE CASCADE,
    run_type text NOT NULL,
    status engine_run_status NOT NULL DEFAULT 'QUEUED',
    input_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
    output_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
    methodology_version text,
    started_at timestamptz,
    finished_at timestamptz,
    error_code text,
    error_detail text,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE envelopes
    DROP CONSTRAINT IF EXISTS envelopes_created_by_engine_run_fkey;
ALTER TABLE envelopes
    ADD CONSTRAINT envelopes_created_by_engine_run_fkey
    FOREIGN KEY (created_by_engine_run) REFERENCES engine_runs(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS engine_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engine_run_id uuid NOT NULL REFERENCES engine_runs(id) ON DELETE CASCADE,
    decision_type text NOT NULL,
    decision_code text NOT NULL,
    severity text NOT NULL,
    facts jsonb NOT NULL,
    rules_evaluated jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mrv_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    drill_id uuid NOT NULL UNIQUE REFERENCES drills(id) ON DELETE CASCADE,
    methodology_version text NOT NULL,
    interval_seconds integer NOT NULL,
    committed_energy_wh bigint NOT NULL,
    delivered_energy_wh bigint NOT NULL,
    average_delivered_kw numeric(14,3) NOT NULL,
    performance_bps integer NOT NULL,
    telemetry_completeness numeric(5,4) NOT NULL,
    maximum_gap_intervals integer NOT NULL DEFAULT 0,
    baseline_series jsonb NOT NULL,
    actual_series jsonb NOT NULL,
    quality_blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
    rebound_energy_wh bigint,
    generated_by_engine_run uuid REFERENCES engine_runs(id) ON DELETE SET NULL,
    generated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (performance_bps >= 0 AND performance_bps <= 10000),
    CHECK (telemetry_completeness >= 0 AND telemetry_completeness <= 1)
);

CREATE TABLE IF NOT EXISTS evidence_bundles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    drill_id uuid REFERENCES drills(id) ON DELETE SET NULL,
    mrv_report_id uuid REFERENCES mrv_reports(id) ON DELETE SET NULL,
    schema_version text NOT NULL,
    canonical_json jsonb NOT NULL,
    canonical_sha256 char(64) NOT NULL UNIQUE,
    storage_uri text,
    signature_algorithm text,
    signature_value text,
    signed_by text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS passports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    envelope_id uuid NOT NULL REFERENCES envelopes(id) ON DELETE RESTRICT,
    evidence_bundle_id uuid NOT NULL REFERENCES evidence_bundles(id) ON DELETE RESTRICT,
    version integer NOT NULL,
    status passport_status NOT NULL DEFAULT 'DRAFT',
    passport_json jsonb NOT NULL,
    passport_sha256 char(64) NOT NULL UNIQUE,
    pdf_storage_uri text,
    issued_at timestamptz,
    issued_by uuid REFERENCES app_users(id),
    superseded_by uuid REFERENCES passports(id),
    revocation_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (facility_id, version)
);

CREATE TABLE IF NOT EXISTS export_packages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    passport_id uuid NOT NULL REFERENCES passports(id) ON DELETE CASCADE,
    counterparty_name text,
    format_code text NOT NULL,
    status export_status NOT NULL DEFAULT 'QUEUED',
    storage_uri text,
    expires_at timestamptz,
    error_detail text,
    requested_by uuid REFERENCES app_users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS emergency_stop_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    drill_id uuid REFERENCES drills(id) ON DELETE SET NULL,
    activated_by uuid REFERENCES app_users(id),
    activated_at timestamptz NOT NULL DEFAULT now(),
    reason_code text NOT NULL,
    reason_detail text,
    cleared_by uuid REFERENCES app_users(id),
    cleared_at timestamptz,
    clear_note text
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
    facility_id uuid REFERENCES facilities(id) ON DELETE SET NULL,
    actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    actor_service text,
    action text NOT NULL,
    object_type text NOT NULL,
    object_id text,
    before_state jsonb,
    after_state jsonb,
    request_id uuid,
    ip_address inet,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_logs (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key text PRIMARY KEY,
    scope text NOT NULL,
    request_hash char(64) NOT NULL,
    response_status integer,
    response_body jsonb,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_heartbeats (
    service_name text PRIMARY KEY,
    instance_id text NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_organizations_updated_at ON organizations;
CREATE TRIGGER trg_organizations_updated_at BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_users_updated_at ON app_users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON app_users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_facilities_updated_at ON facilities;
CREATE TRIGGER trg_facilities_updated_at BEFORE UPDATE ON facilities
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_mechanisms_updated_at ON flexibility_mechanisms;
CREATE TRIGGER trg_mechanisms_updated_at BEFORE UPDATE ON flexibility_mechanisms
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_connectors_updated_at ON connectors;
CREATE TRIGGER trg_connectors_updated_at BEFORE UPDATE ON connectors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_drills_updated_at ON drills;
CREATE TRIGGER trg_drills_updated_at BEFORE UPDATE ON drills
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_telemetry_append_only ON telemetry_readings;
CREATE TRIGGER trg_telemetry_append_only BEFORE UPDATE OR DELETE ON telemetry_readings
FOR EACH ROW EXECUTE FUNCTION reject_mutation();
DROP TRIGGER IF EXISTS trg_drill_events_append_only ON drill_events;
CREATE TRIGGER trg_drill_events_append_only BEFORE UPDATE OR DELETE ON drill_events
FOR EACH ROW EXECUTE FUNCTION reject_mutation();
DROP TRIGGER IF EXISTS trg_evidence_append_only ON evidence_bundles;
CREATE TRIGGER trg_evidence_append_only BEFORE UPDATE OR DELETE ON evidence_bundles
FOR EACH ROW EXECUTE FUNCTION reject_mutation();
DROP TRIGGER IF EXISTS trg_audit_append_only ON audit_logs;
CREATE TRIGGER trg_audit_append_only BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_mutation();

COMMIT;
