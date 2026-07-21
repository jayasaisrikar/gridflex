# GridFlex V2 — TypeScript Coding Agent Implementation Specification

**Product:** Flexibility Assurance Platform for Large Digital Loads  
**Primary artifact:** The Flexibility Passport  
**Implementation target:** Production-shaped TypeScript MVP, stages 1–3 of the trust ladder  
**Database:** Existing PostgreSQL resource hosted in Coolify  
**Security rule:** Live credentials are supplied in a separate private environment file and must never be copied into source code, logs, screenshots, issues, or Git history.

---

## 0. Governing instruction to the coding agent

Read this entire specification and the companion files before writing code. Treat `gridflex_schema.sql` as the initial database contract and `GridFlex_private.env` as a deployment-only secret. Do not invent blockchain, crypto settlement, a marketplace, autonomous dispatch, or direct production control. V1 ships only read-only telemetry, shadow calculations, operator-approved drills, deterministic MRV, and versioned Flexibility Passports.

Build a working vertical slice before adding breadth:

1. Connect to PostgreSQL and run migrations.
2. Create the canonical demo facility.
3. Ingest simulator telemetry.
4. Compute a flexibility envelope.
5. Create, arm, run, and verify a drill.
6. Produce MRV evidence.
7. Issue Passport JSON and PDF.
8. Display the entire proof chain in the web UI.

Never let an LLM create or modify telemetry, envelope values, MRV numbers, safety limits, evidence hashes, or Passport facts. Optional narrative text may be generated only from already-verified structured JSON.

## 1. Product objective

GridFlex proves how much electrical load a large data center, AI-compute facility, HPC cluster, or mining operation can safely reduce, how quickly it can respond, how long it can sustain the response, and what rebound follows. The result is a signed, versioned Flexibility Passport that a utility, QSE/aggregator, lender, consultant, or tenant can independently review.

The first commercial wedge is assurance, not market bidding. The system must make every claim traceable to telemetry, constraints, tests, formulas, methodology versions, and immutable evidence.

## 2. Scope

### 2.1 Build now

- Single-customer deployment with organization and facility boundaries retained in the schema.
- Email/password authentication and role-based authorization.
- Facility setup and safety constraints.
- Simulator connector and CSV interval-meter import.
- Connector health and ingestion history.
- Append-only telemetry storage.
- Data-quality scoring and quarantine.
- Flexibility-envelope computation with per-field provenance.
- Drill planning, two-step operator arming, execution/replay, emergency stop, and event timeline.
- Deterministic MRV.
- Canonical evidence bundle and SHA-256 hash.
- Versioned Passport JSON and rendered PDF.
- Counterparty export package.
- Audit log.
- Coolify deployment for web, API, worker, and the existing PostgreSQL database.

### 2.2 Explicit non-goals

- No Casper, tokens, CSPR, x402, escrow, on-chain settlement, wallet, oracle, or relayer.
- No two-sided marketplace.
- No autonomous financial commitment or bidding.
- No unsupervised production control.
- No direct control of real electrical equipment in V1.
- No claims of regulatory certification or guaranteed interconnection approval.
- No carbon accounting.
- No support for EV fleets or residential assets.

## 3. Trust ladder and release boundary

| Stage | Capability | V1 status | Gate |
|---|---|---:|---|
| 1 | Read-only telemetry and modeling | Ship | 95% completeness over 14 days |
| 2 | Shadow recommendations | Ship | Operator reviews at least five shadow events |
| 3 | Operator-approved drills | Ship | Two drills predicted within ±20% of delivery |
| 4 | Supervised dispatch | Do not ship | Separate production authorization |
| 5 | Bounded automation | Do not ship | Written authorization and safety record |

The application must visually label simulated, replayed, modeled, declared, and tested values.

## 4. Fixed technology choices

| Layer | Choice |
|---|---|
| Runtime | Node.js 24 LTS, TypeScript in strict mode, pnpm workspaces |
| Frontend | Next.js App Router, TypeScript, Tailwind CSS, TanStack Query, Zod |
| API | NestJS 11 with the Fastify 5 adapter; REST under `/api/v1` |
| Validation/contracts | Shared Zod schemas with a custom NestJS validation pipe; OpenAPI generated from explicit route metadata |
| Database access | Drizzle ORM with `node-postgres` (`pg`) connection pooling |
| Migrations | Drizzle Kit generated/reviewed SQL; initial migration is the supplied authoritative SQL, including extensions, enums, indexes, functions, and triggers |
| Worker | Separate NestJS standalone application using `@nestjs/schedule` and PostgreSQL advisory locks |
| Auth | Argon2id passwords, short-lived JWT access tokens, rotating opaque refresh tokens stored as SHA-256 hashes |
| Charts | Recharts |
| PDF | Playwright HTML-to-PDF with deterministic templates and visual regression tests |
| Tests | Vitest, `@nestjs/testing`, Fastify injection/Supertest where appropriate, Testcontainers/PostgreSQL, Playwright |
| Packaging | Multi-stage Dockerfiles plus Coolify deployments |
| Storage | Mounted persistent volume for PDF/evidence files in V1; S3-compatible adapter later |

Do not add microservices. Deploy three code processes from one monorepo: `web`, `api`, and `worker`. The API and worker share domain packages and the database package, but are separate Coolify applications/processes.

### 4.1 TypeScript engineering rules

- Set `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, and `useUnknownInCatchVariables: true`.
- Do not use `any` except at a documented third-party boundary; narrow `unknown` immediately.
- Represent energy and monetary values crossing API boundaries as decimal strings. Convert deliberately inside deterministic calculation modules.
- Keep the assurance engine framework-independent and side-effect-free under `packages/engine`.
- Keep request/response schemas in `packages/contracts`; the web and API import the same schemas.
- Keep all SQL access inside repositories in `packages/db`; controllers must not issue SQL.
- Use UTC internally and preserve each facility's IANA timezone only for presentation and schedule interpretation.
- Use `Result`-style typed domain errors or explicit error classes with stable codes; never branch on error-message text.
- Do not use `drizzle-kit push` against production. Generate and review migrations, back up, then run `drizzle-kit migrate`.

## 5. Repository structure

```text
gridflex/
  apps/
    web/
      src/app/
      src/components/
      src/features/
      src/lib/
      public/
      tests/e2e/
      Dockerfile
    api/
      src/
        modules/
          auth/
          facilities/
          connectors/
          telemetry/
          envelopes/
          drills/
          mrv/
          evidence/
          passports/
          exports/
          health/
        common/
          auth/
          errors/
          guards/
          interceptors/
          pipes/
        main.ts
      tests/
      Dockerfile
    worker/
      src/jobs/
      src/main.ts
      tests/
      Dockerfile
  packages/
    contracts/
      src/auth.ts
      src/facilities.ts
      src/telemetry.ts
      src/envelopes.ts
      src/drills.ts
      src/passports.ts
      src/errors.ts
    db/
      src/client.ts
      src/schema.ts
      src/repositories/
      drizzle/
        0000_initial_gridflex.sql
      drizzle.config.ts
      scripts/seed.ts
    engine/
      src/baseline/
      src/envelope/
      src/mrv/
      src/canonical-json/
      src/simulator/
      tests/
    config/
      src/env.ts
      src/logger.ts
  infra/
    sql/
      gridflex_schema.sql
      gridflex_seed.sql
    coolify/
      deployment-checklist.md
  docs/
    architecture.md
    api.md
    data-dictionary.md
    implementation-status.md
    runbook.md
  .env.example
  pnpm-workspace.yaml
  package.json
  tsconfig.base.json
  docker-compose.local.yml
  README.md
```

Use pnpm workspace packages. Avoid a build system until build times justify one; plain pnpm recursive scripts are sufficient for the MVP.

## 6. Database connection and secret handling

The live connection details are in `GridFlex_private.env`. Use them only as Coolify environment variables. Never hardcode them.

The supplied database hostname appears to be an internal Coolify/Docker service name. It will normally resolve only when the API, worker, and database share the same Coolify network or destination. If local development cannot resolve the host, do not change application code. Use a local Postgres container, a controlled public port, or a secure tunnel and override the environment variable locally.

### 6.1 Connection behavior

- API and worker use the same plain PostgreSQL `DATABASE_URL` through `node-postgres` and Drizzle.
- Create one `pg.Pool` per process with `max: 10`, `idleTimeoutMillis: 30_000`, and `connectionTimeoutMillis: 5_000` initially.
- Run `SET statement_timeout = '30s'` for ordinary request connections; long export jobs must opt into a documented higher timeout.
- Parse PostgreSQL `numeric` values deliberately. Do not globally coerce all numeric values to JavaScript `number` where precision could matter.
- Use explicit transactions for every state transition and `SELECT ... FOR UPDATE` for competing drill/envelope changes.
- Never auto-run migrations during API startup.
- Run `pnpm db:migrate` as a controlled one-off deployment command before switching traffic.
- Production migrations must be forward-safe. A rollback means restoring the previous application and, when necessary, restoring a tested database backup—not improvising destructive down migrations.

### 6.2 Startup checks

The API health check must separately report:

```json
{
  "status": "ok",
  "database": "reachable",
  "schema_revision": "<drizzle migration id>",
  "worker_last_seen": "<timestamp>",
  "storage": "writable"
}
```

Do not expose hostnames, credentials, stack traces, or SQL in public health responses.

## 7. Database source of truth

The companion `gridflex_schema.sql` defines the complete initial database contract. Copy it as the reviewed initial Drizzle SQL migration, then create matching Drizzle table definitions in `packages/db/src/schema.ts`. The SQL migration remains authoritative for extensions, enum creation, functions, triggers, and other database features that are not safely generated. Do not change names or semantics unless a migration note and contract test explain the change.

### 7.1 Table groups

**Identity, tenancy, and sessions**

- `organizations`
- `app_users`
- `organization_members`
- `auth_refresh_tokens`

**Facilities and capability**

- `facilities`
- `facility_constraints`
- `flexibility_mechanisms`

**Data acquisition**

- `connectors`
- `connector_sync_runs`
- `telemetry_readings`
- `telemetry_quarantine`

**Assurance engine**

- `envelopes`
- `envelope_mechanisms`
- `engine_runs`
- `engine_decisions`

**Drills and proof**

- `drills`
- `drill_events`
- `mrv_reports`
- `evidence_bundles`
- `passports`
- `export_packages`

**Safety and governance**

- `drill_arm_challenges`
- `emergency_stop_events`
- `audit_logs`
- `idempotency_keys`
- `service_heartbeats`

### 7.2 Immutability rules

Database triggers reject UPDATE and DELETE on:

- `telemetry_readings`
- `drill_events`
- `evidence_bundles`
- `audit_logs`

Corrections are represented by new rows, quality flags, superseding Passport versions, or explicit revocation records. Never weaken append-only rules to make tests easier.

### 7.3 Telemetry retention

For the MVP, retain raw telemetry indefinitely. Add BRIN and facility/time indexes as defined in the schema. Do not install TimescaleDB unless the existing PostgreSQL image actually supports it. Standard PostgreSQL must remain the supported baseline.

## 7.4 Required database package pattern

```ts
// packages/db/src/client.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export const db = drizzle({ client: pool });
```

The coding agent must wrap this in a NestJS database module with lifecycle hooks that verify connectivity on startup and close the pool on shutdown. Never instantiate a new pool per request.

## 8. Authentication and RBAC

### 8.1 Roles

| Role | Main permissions |
|---|---|
| OWNER | Full organization access, membership, settings, exports |
| FACILITY_ADMIN | Facility configuration, connectors, constraints, drills, passports |
| OPS_ENGINEER | Telemetry, drill planning/arming, emergency stop, operational review |
| REVIEWER | Read envelopes, evidence, Passport, export packages; add review note |
| VIEWER | Read-only dashboard and Passport |

### 8.2 Authentication endpoints

```text
POST /api/v1/auth/bootstrap-owner
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
GET  /api/v1/auth/me
POST /api/v1/auth/change-password
```

`bootstrap-owner` works only when no users exist and must be disabled forever after the first account is created. Passwords require 12 characters minimum and are hashed with Argon2id. Access tokens are JWTs with a 15-minute default lifetime. Refresh tokens are high-entropy opaque values; store only their SHA-256 hashes in `auth_refresh_tokens`, rotate them on every use, detect token-family reuse, and revoke the family on logout, password change, or suspected theft.

## 9. API contract

All endpoints live under `/api/v1`. Use UUID strings, RFC 3339 UTC timestamps, decimal strings for precision-sensitive energy values, and a common error envelope:

```json
{
  "error": {
    "code": "TELEMETRY_STALE",
    "message": "A current drill cannot be armed because telemetry is stale.",
    "details": {"last_reading_at": "..."},
    "request_id": "..."
  }
}
```

### 9.1 Facilities

```text
GET    /facilities
POST   /facilities
GET    /facilities/{facility_id}
PATCH  /facilities/{facility_id}
GET    /facilities/{facility_id}/constraints
POST   /facilities/{facility_id}/constraints
GET    /facilities/{facility_id}/mechanisms
POST   /facilities/{facility_id}/mechanisms
PATCH  /facilities/{facility_id}/mechanisms/{mechanism_id}
```

### 9.2 Connectors and telemetry

```text
GET    /facilities/{facility_id}/connectors
POST   /facilities/{facility_id}/connectors
POST   /connectors/{connector_id}/test
POST   /connectors/{connector_id}/sync
GET    /connectors/{connector_id}/sync-runs
POST   /facilities/{facility_id}/telemetry/csv
POST   /facilities/{facility_id}/telemetry/batch
GET    /facilities/{facility_id}/telemetry
GET    /facilities/{facility_id}/telemetry/quality
GET    /facilities/{facility_id}/telemetry/quarantine
```

Batch ingestion request:

```json
{
  "source_key": "simulator-main-meter",
  "readings": [
    {
      "metric_key": "facility.active_power_kw",
      "measured_at": "2026-07-21T12:00:00Z",
      "value": 1600.25,
      "unit": "kW",
      "quality": "GOOD",
      "source_sequence": "16842"
    }
  ]
}
```

The endpoint must be idempotent under the table unique constraint. Exact duplicates return success with `inserted=0, duplicates=n`; conflicting duplicates are quarantined.

### 9.3 Envelopes

```text
POST /facilities/{facility_id}/envelopes/recompute
GET  /facilities/{facility_id}/envelopes/current
GET  /facilities/{facility_id}/envelopes
GET  /envelopes/{envelope_id}
GET  /envelopes/{envelope_id}/explanation
```

Recompute creates an `engine_run`, validates data quality, computes per-mechanism values, writes decisions/reason codes, and atomically marks the new envelope `CURRENT` while superseding the previous current version.

### 9.4 Drills

```text
GET  /facilities/{facility_id}/drills
POST /facilities/{facility_id}/drills
GET  /drills/{drill_id}
POST /drills/{drill_id}/validate
POST /drills/{drill_id}/arm-intent
POST /drills/{drill_id}/arm-confirm
POST /drills/{drill_id}/start
POST /drills/{drill_id}/abort
POST /drills/{drill_id}/complete
POST /drills/{drill_id}/verify
GET  /drills/{drill_id}/events
GET  /drills/{drill_id}/mrv
```

Arming is a two-step operation. `arm-intent` returns a short-lived challenge containing the exact constraints and expected effects. `arm-confirm` requires the challenge ID and a typed confirmation phrase. Challenges expire after five minutes and are single-use.

### 9.5 Passport and exports

```text
POST /facilities/{facility_id}/passports/issue
GET  /facilities/{facility_id}/passports
GET  /passports/{passport_id}
GET  /passports/{passport_id}/json
GET  /passports/{passport_id}/pdf
GET  /passports/{passport_id}/verify
POST /passports/{passport_id}/exports
GET  /exports/{export_id}
```

Passport issuance is blocked unless the envelope is current, evidence canonicalization succeeds, telemetry quality meets the threshold, and any associated drill has an MRV report.

## 10. Telemetry and connector rules

### 10.1 Canonical metrics

At minimum support:

| Metric | Unit | Required |
|---|---|---:|
| `facility.active_power_kw` | kW | Yes |
| `facility.energy_kwh_interval` | kWh | Derived or supplied |
| `it.active_power_kw` | kW | Preferred |
| `cooling.active_power_kw` | kW | Preferred |
| `ups.discharge_kw` | kW | Optional |
| `battery.state_of_charge_pct` | % | Optional |
| `thermal.max_inlet_c` | °C | Optional but required for cooling drill |
| `scheduler.deferrable_load_kw` | kW | Optional |
| `scheduler.critical_load_kw` | kW | Optional |

### 10.2 Quality gates

- Envelope recomputation requires at least 90% completeness for the selected modeling window.
- A production-quality Passport target is 95% completeness over 14 days.
- Drill certification is blocked below 90%, with more than two consecutive missing intervals, invalid timestamps, duplicate conflicts, or failed canonical hashing.
- Stale telemetry blocks arming. Default stale threshold: two expected intervals plus 60 seconds.
- All blocked actions write an `engine_decision` or `drill_event` with a stable reason code.

### 10.3 CSV format

```csv
measured_at,metric_key,value,unit,source_sequence
2026-07-21T12:00:00Z,facility.active_power_kw,1600.25,kW,1
```

Return a preview and validation report before committing rows. The user explicitly confirms the import.

## 11. Simulator

The built-in simulator is a deterministic digital twin used for development, demos, tests, and pre-connection modeling. It must be clearly labeled `SIMULATED` throughout the UI.

Canonical facility:

- Normal load: 1,600 kW
- Minimum safe load: 900 kW
- Maximum curtailment: 600 kW
- Maximum ramp: 100 kW/min
- Cooling reserve: 150 kW
- Drill request: 500 kW for 30 minutes
- Expected average delivery: approximately 490 kW
- Expected delivered energy: approximately 245 kWh
- Expected performance: approximately 98%

Use seeded pseudorandom noise. A given seed must generate identical telemetry and MRV output. Provide fault injection for stale telemetry, missing intervals, thermal violation, ramp violation, failed actuator acknowledgement, and emergency stop.

## 12. Envelope engine

The engine is deterministic and versioned. Each output field carries `DECLARED`, `MODELED`, or `TESTED` provenance.

### 12.1 Computation sequence

1. Load active constraints and enabled mechanisms.
2. Select a modeling window and calculate data completeness.
3. Decompose facility load using direct submeter metrics where available; otherwise use conservative estimates.
4. Compute the observed operating floor from eligible low-load intervals.
5. Calculate mechanism caps from operator constraints, scheduler metadata, storage state, thermal headroom, and drill history.
6. Fit observed ramp rates from stable transitions.
7. Fit sustainable duration from tests or conservatively use declared limits with reduced confidence.
8. Model rebound peak and energy from post-event observations.
9. Apply the minimum of all relevant caps.
10. Compute confidence and write reason codes.

### 12.2 Conservative first-pass formulas

```text
physical_headroom_kw = max(0, p50_normal_load_kw - minimum_safe_load_kw)
mechanism_cap_kw = min(declared_cap_kw, observed_cap_kw, constraint_cap_kw)
total_reducible_kw = min(sum(enabled mechanism caps), physical_headroom_kw, maximum_curtailment_kw)
```

Confidence begins from the weakest data source and is adjusted by test history:

```text
DECLARED base confidence = 0.35
MODELED base confidence  = 0.60
TESTED base confidence   = 0.85
```

Penalize for missing data, stale constraints, short windows, high residual error, and contradictory tests. Cap at 0.95 until an external reviewer or production event is recorded. Store every adjustment in `engine_decisions`.

## 13. Drill state machine

Allowed transitions:

```text
DRAFT -> READY -> ARMED -> RUNNING -> VERIFYING -> COMPLETED
  |        |        |         |            |
  +------> CANCELLED          ABORTED      FAILED
```

No endpoint may directly set arbitrary status. Implement transition functions under database transactions and row locks. An active emergency stop blocks `ARMED` and `RUNNING`. Only one live drill per facility is permitted.

### 13.1 Safety invariants

- Actual or simulated setpoint never falls below minimum safe load.
- Requested reduction never exceeds the current envelope or constraints.
- Ramp never exceeds the configured maximum.
- Maximum duration cannot be exceeded.
- Thermal limit violation aborts immediately.
- Telemetry staleness aborts or prevents start according to policy.
- Emergency stop preempts every operation.
- Every transition writes a drill event and audit log.

## 14. MRV engine

Baseline:

```text
baseline_kw_t = median(same relative interval, previous 5 eligible days)
fallback      = median(last 12 non-event intervals)
```

Delivery:

```text
delivered_wh = Σ max(0, baseline_kw_t - actual_kw_t) × interval_minutes × 1000 / 60
performance_bps = min(10000, delivered_wh × 10000 / committed_energy_wh)
```

Rules:

- Store both baseline and actual series in the MRV report.
- Record the exact eligible days and excluded intervals.
- Never silently interpolate gaps for certified output.
- Report rebound separately; do not subtract or hide it unless a named methodology requires it.
- The canonical scenario must yield 240–250 kWh and 9,600–10,000 bps.
- Unit tests use Decimal or integer Wh where possible; do not depend on floating-point equality.

## 15. Evidence and Passport

### 15.1 Canonicalization

- Serialize using UTF-8.
- Sort object keys recursively.
- Use no insignificant whitespace.
- Normalize timestamps to UTC RFC 3339 with `Z`.
- Represent precision-sensitive decimals as strings.
- Compute SHA-256 over the canonical bytes.
- Store the canonical JSON and hash together.

### 15.2 Passport content

Every Passport contains:

- Facility identity and methodology version.
- Current envelope and validity window.
- Per-mechanism capacity, ramp, duration, rebound, confidence, and provenance.
- Safety constraints and excluded workloads.
- Data-quality summary and connector provenance.
- Drill/test history.
- MRV summaries.
- Evidence hash.
- Issue timestamp and version.
- Plain-language limitations.

Once issued, a Passport is never edited. A later Passport supersedes it. Revocation preserves the original data and adds a reason.

### 15.3 PDF design

Create a professional engineering report, not a marketing brochure. Required pages:

1. Cover and status.
2. Executive flexibility summary.
3. Envelope by mechanism.
4. Safety limits and exclusions.
5. Data quality and source provenance.
6. Drill history and latest MRV chart.
7. Methodology and limitations.
8. Evidence hash and verification instructions.

Add snapshot tests for the rendered PDF and keep simulator/replay labels prominent.

## 16. Frontend requirements

### 16.1 Navigation

```text
Overview
Telemetry
Envelope
Drills
Passport
Facility & Safety
Connectors
Audit
```

### 16.2 Overview

Show:

- Current load and freshness.
- Tested, modeled, and declared reducible kW.
- Current Passport status and staleness.
- Telemetry completeness.
- Connector health.
- Next safe action.

### 16.3 Drill page

The drill page must read as one proof chain:

```text
Plan -> Validation -> Operator arming -> Execution -> Telemetry -> MRV -> Evidence hash -> Passport
```

Display immutable event timestamps, actor, reason codes, baseline/actual chart, performance, safety status, and downloads.

### 16.4 UX rules

- Dark neutral professional control-room theme.
- Green only for tested/verified.
- Amber for declared/modeled or stale.
- Red only for violations, aborts, and blockers.
- Never rely on color alone.
- Plain language first, engineering detail expandable.
- Destructive or operational actions require explicit confirmation.
- No fake live data. Simulated data is always labeled.

## 17. Worker jobs

Run a separate compiled Node.js worker process from the same monorepo. It boots a NestJS application context without an HTTP listener.

| Job | Default schedule |
|---|---|
| Connector polling | Per connector, minimum 30 sec |
| Telemetry quality sweep | Every 5 min |
| Envelope staleness check | Every 15 min |
| Recompute eligible envelopes | Hourly or on demand |
| Passport staleness propagation | Every 15 min |
| Export cleanup | Daily |
| Idempotency-key cleanup | Hourly |
| Worker heartbeat | Every 30 sec |

Use PostgreSQL advisory locks so only one worker performs a job. Record `engine_runs` for material calculations.

## 18. Security

- Secrets only in Coolify environment variables or mounted files.
- Encrypt connector credentials at application level using a key distinct from `AUTH_SECRET`.
- Rate-limit login and ingestion endpoints.
- Validate uploaded CSV size, type, row count, timestamps, and formulas.
- Sanitize filenames and generate storage paths server-side.
- Set CSP, HSTS, secure cookies, and strict CORS.
- Use organization/facility authorization checks on every query.
- Avoid logging raw telemetry batches, passwords, tokens, connection URLs, or connector secrets.
- Back up the database before every destructive migration.
- Maintain audit logs for configuration changes, arming, aborting, Passport issuance, export, user management, and credential changes.

Because the database password has been shared in conversation, rotate it after the first successful deployment and update all Coolify environment variables.

## 19. Testing

### 19.1 Unit tests

- Baseline selection and fallback.
- Delivery and performance formulas.
- Data-quality thresholds.
- Envelope caps and confidence.
- Drill transition rules.
- Emergency stop preemption.
- Canonical JSON and stable SHA-256.
- Authorization matrix.

### 19.2 Integration tests

- API plus a real PostgreSQL Testcontainer.
- Drizzle migration from an empty database.
- Append-only triggers reject mutation.
- Duplicate telemetry is idempotent.
- CSV quarantine behavior.
- Full simulator-to-Passport workflow.
- Concurrent drill arming is rejected.
- Worker advisory lock.

### 19.3 End-to-end tests

Using Playwright:

1. Bootstrap owner.
2. Open seeded facility.
3. Start simulator.
4. Recompute envelope.
5. Create drill.
6. Complete two-step arming.
7. Run accelerated drill.
8. Inspect MRV.
9. Issue Passport.
10. Download JSON and PDF.
11. Verify hash.
12. Trigger a stale-telemetry failure and emergency-stop test.

## 20. Coolify deployment

Create three application resources in the same Coolify project/destination as the existing database:

1. `gridflex-web`
2. `gridflex-api`
3. `gridflex-worker`

The internal database hostname supplied in the private environment file should then be reachable through the shared Docker network.

### 20.1 API

- Build context: repository root.
- Dockerfile: `apps/api/Dockerfile`.
- Compile with `pnpm --filter @gridflex/api build`.
- Start with `node apps/api/dist/main.js`.
- Expose port 4000.
- Health path: `/health/ready`.
- Mount `/data/gridflex/evidence` and `/data/gridflex/passports` as persistent volumes.
- Add all secret environment variables from `GridFlex_private.env`.

### 20.2 Worker

- Dockerfile: `apps/worker/Dockerfile` or the shared Node build image.
- Command: `node apps/worker/dist/main.js`.
- No public domain.
- Same DB and storage environment variables and mounts.

### 20.3 Web

- Dockerfile: `apps/web/Dockerfile`.
- Expose port 3000.
- Public HTTPS domain.
- Server-side API URL points to the API internal URL; browser API calls may use a public API domain or Next.js proxy route.

### 20.4 Migration release sequence

1. Confirm a fresh database backup.
2. Deploy new API image without switching traffic if possible.
3. Run `pnpm db:migrate` as a one-off command.
4. Run `pnpm db:check` and migration smoke tests.
5. Deploy worker.
6. Deploy web/API traffic.
7. Verify health, create a test telemetry row, issue a demo Passport.
8. Roll back the application image if health fails. Do not apply an untested reverse migration; restore from the pre-migration backup when the schema change is not backward compatible.

## 21. How to inspect the PostgreSQL database

Coolify manages and exposes the database resource, terminal, connection details, and backups, but use a dedicated database client for comfortable table browsing and SQL editing.

### Recommended: pgAdmin inside Coolify

Deploy Coolify's pgAdmin service in the same project/network. Open its web domain and register a server with:

```text
Host: xgpmainz1zkr3ga9q7d4ghz4
Port: 5432
Maintenance database: postgres
Username: postgres
Password: use the value from GridFlex_private.env
SSL: Prefer/disable for the private Docker network according to the database setup
```

This keeps PostgreSQL off the public internet.

### Command line

From the API container or another container in the same network:

```bash
psql "$DATABASE_URL"
```

Useful commands:

```text
\dt                 list tables
\d telemetry_readings
\x                  expanded display
SELECT current_database(), current_user;
SELECT * FROM facilities;
```

### Desktop clients

DBeaver, pgAdmin Desktop, DataGrip, and TablePlus can connect only when PostgreSQL is reachable from your computer. The internal Coolify hostname will not normally resolve on Windows. To use a desktop client, expose a Coolify public port or create a secure network/tunnel. Restrict access to your IP and use TLS where possible; do not leave port 5432 open to the world.

## 22. Backups and operations

- Configure automated PostgreSQL backups in Coolify to S3-compatible storage.
- Daily backup minimum; retain 7 daily and 4 weekly copies for the pilot.
- Trigger a manual backup before migrations.
- Perform a restore drill before onboarding a design partner.
- Alert on database disk usage, failed backups, connector failure, worker heartbeat failure, telemetry staleness, and repeated authentication failures.

## 23. Implementation phases

### Phase A — Foundation

- Monorepo, Dockerfiles, linting, tests.
- Drizzle schema definitions and reviewed SQL migration matching `gridflex_schema.sql`.
- Health checks and owner bootstrap.
- Seed command.

**Exit:** empty database migrates cleanly, owner can sign in, seeded facility appears.

### Phase B — Telemetry

- Simulator.
- CSV preview/import.
- Batch ingestion and idempotency.
- Telemetry charts, quality, quarantine.

**Exit:** 24 simulated hours ingest reproducibly and append-only triggers pass.

### Phase C — Envelope

- Constraints and mechanisms.
- Engine runs and reason codes.
- Current envelope UI with provenance.

**Exit:** canonical facility produces a conservative envelope with explainable calculations.

### Phase D — Drill and MRV

- State machine, arming challenge, emergency stop.
- Accelerated simulator drill.
- Baseline and MRV.

**Exit:** canonical drill produces 240–250 kWh and 9,600–10,000 bps with zero violations.

### Phase E — Passport

- Evidence canonicalization and hashing.
- Passport JSON/PDF.
- Versioning, verification, export package.

**Exit:** a reviewer can follow the complete proof chain and independently recompute the hash.

### Phase F — Production readiness

- RBAC hardening.
- Backups, observability, rate limits, audit coverage.
- Coolify deployment and runbook.
- E2E and failure tests.

**Exit:** deployment survives restart, restore, stale telemetry, duplicate input, failed connector, concurrent arming, and emergency stop.

## 24. Definition of done

- The application uses the supplied Coolify PostgreSQL database through environment variables.
- Drizzle migrations create all tables, enums, constraints, indexes, functions, and triggers from the companion schema.
- No live secret appears in Git or frontend bundles.
- A user can connect telemetry, review data quality, compute an envelope, arm and run a drill, inspect MRV, and export a Passport without developer intervention.
- Every Passport field has provenance.
- Evidence and Passport hashes are reproducible.
- Canonical drill passes the specified acceptance range.
- Append-only data cannot be updated or deleted through SQL or APIs.
- Simulated/replayed data is unmistakably labeled.
- No blockchain dependency exists in the critical path.
- Database backups are configured and a restore has been tested.

## 25. Exact first commands for the coding agent

```bash
# 1. Verify the supported runtime and install workspace dependencies
node --version   # Node 24 LTS
corepack enable
pnpm install --frozen-lockfile

# 2. Create a safe local environment
cp .env.example .env
# Never paste the production credential into a committed file.

# 3. Start local PostgreSQL for development
pnpm local:db:up

# 4. Apply the reviewed initial SQL migration and verify the schema contract
pnpm db:migrate
pnpm db:check
pnpm --filter @gridflex/db test

# 5. Bootstrap and seed through TypeScript CLI scripts
pnpm db:bootstrap-owner
pnpm db:seed

# 6. Run all three processes
pnpm --filter @gridflex/api dev
pnpm --filter @gridflex/worker dev
pnpm --filter @gridflex/web dev

# 7. Run quality gates
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
```

Recommended root scripts:

```json
{
  "scripts": {
    "dev": "pnpm -r --parallel --filter './apps/*' dev",
    "build": "pnpm -r build",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "test:e2e": "pnpm --filter @gridflex/web test:e2e",
    "db:generate": "pnpm --filter @gridflex/db drizzle-kit generate",
    "db:migrate": "pnpm --filter @gridflex/db drizzle-kit migrate",
    "db:check": "pnpm --filter @gridflex/db tsx scripts/check-schema.ts",
    "db:seed": "pnpm --filter @gridflex/db tsx scripts/seed.ts",
    "local:db:up": "docker compose -f docker-compose.local.yml up -d postgres"
  }
}
```

Do not point local experiments at the production database. Use the supplied database only for the Coolify deployment or an explicitly controlled, backed-up migration run.

