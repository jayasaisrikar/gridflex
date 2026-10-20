-- GridFlex agent harness: agent sessions and Scope 2 carbon reports.
-- Reviewed migration (spec 4.1): authored SQL, applied with drizzle-kit migrate.
-- The Drizzle definitions in packages/db/src/schema.ts mirror this file exactly.

BEGIN;

DO $$ BEGIN
    CREATE TYPE agent_session_status AS ENUM ('RUNNING','AWAITING_APPROVAL','COMPLETED','REFUSED','ABORTED','STEP_BUDGET_EXHAUSTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS agent_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    drill_id uuid REFERENCES drills(id) ON DELETE SET NULL,
    status agent_session_status NOT NULL DEFAULT 'RUNNING',
    situation text NOT NULL,
    harness_version text NOT NULL,
    model_id text NOT NULL,
    steps jsonb NOT NULL DEFAULT '[]'::jsonb,
    plan_fingerprint text,
    approved_by uuid REFERENCES app_users(id),
    approved_at timestamptz,
    total_input_tokens integer NOT NULL DEFAULT 0,
    total_output_tokens integer NOT NULL DEFAULT 0,
    started_by uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_facility
    ON agent_sessions (facility_id, started_at DESC);

CREATE TABLE IF NOT EXISTS carbon_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    drill_id uuid NOT NULL REFERENCES drills(id) ON DELETE CASCADE,
    methodology_version text NOT NULL,
    report_json jsonb NOT NULL,
    report_sha256 char(64) NOT NULL UNIQUE,
    emission_factor_source text NOT NULL,
    emission_factor_version text NOT NULL,
    avoided_tco2e numeric(12,3) NOT NULL,
    baseline_tco2e numeric(12,3) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
