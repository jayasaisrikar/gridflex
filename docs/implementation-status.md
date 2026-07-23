# GridFlex V2 — Implementation Status

**Snapshot:** 2026-07-23
**Release state:** **Pilot candidate; final release gate remains open.**

This file records what the repository actually implements today. “Implemented”
means code and focused tests exist. It does not mean the Coolify deployment,
backup/restore procedure, or every browser journey has been proven in the target
environment.

GridFlex is currently a **simulated-pilot assurance product**, not a production
load-control or market-dispatch system. Simulated data is labelled throughout
telemetry, drill evidence, Passports, exports, and the UI.

## Release gate

| Gate | Current result | Release impact |
|---|---|---|
| Main-branch sync | Local `main` fast-forwarded to `origin/main` at `13c274c`, then pilot work reapplied and conflicts resolved | Clear |
| ESLint | Pass: `pnpm lint` | Clear |
| Strict TypeScript | Pass across all 8 non-root workspace projects, including the pulled forecast package: `pnpm typecheck` | Clear |
| Production workspace build | Pass after the main sync: config, engine, forecast, contracts, database, API, worker, and Next.js | Clear |
| Schema/migration check | Pass on local PostgreSQL: 26 tables, 12 enums, required append-only triggers and indexes | Clear locally |
| Engine/forecast/contracts/worker/web tests | 138 / 309 / 27 / 9 / 4 passing on this snapshot | Clear |
| Forecast PostgreSQL integration tests | 16 present across the approval-gated executor and safety-connector suites | Current local-PostgreSQL run is pending with the other database-backed gates |
| Database tests | 11 present: both database-configuration unit tests pass on this snapshot; all 9 append-only PostgreSQL tests passed in the earlier local release run | Current PostgreSQL rerun is pending because local Docker access was rejected by the same approval/tool-usage limit |
| API tests | 52 present: all 12 database-free safety/export unit tests pass on this snapshot; all 40 PostgreSQL-backed integration tests passed in the earlier local release run | Current combined PostgreSQL rerun is pending; do not treat earlier evidence as a fresh post-hardening run |
| Production images | API, worker, and web images built and excluded private env files in the earlier release run | Rebuild images after the main sync before deployment; the current workspace production build is green |
| Real browser suite | 15 checks are listed. Latest executed diagnostic: **11 of 14 passed**; three harness assertions were corrected afterward but the final suite could not be launched because the approval reviewer reported an account/tool-usage limit | **Blocked:** corrected 15-check suite is unexecuted; Passport/PDF browser verification was not reached in the diagnostic |
| Target deployment | Coolify cutover, backup, restore drill, and external monitoring have not been executed | **Required before a design-partner pilot** |

Do not call the release pilot-ready until all 15 Playwright checks pass and the
target-environment items in the final row have named owners and evidence.

## Phase status

| Phase | Status | What that means |
|---|---|---|
| A — Foundation | Complete in the local pilot environment | Reviewed migration, schema verification, seed, owner bootstrap/sign-in, health endpoints, and three applications exist |
| B — Telemetry | Complete for the pilot data-source boundary | Deterministic simulator and preview/confirm CSV ingestion work; real vendor connector adapters do not |
| C — Envelope | Complete for conservative declared/modelled envelopes | Versioned explainable envelopes work; observed/tested mechanism-cap promotion is not yet wired into application inputs |
| D — Drill and MRV | Complete for accelerated simulated drills | Two-step arming, safety gates, emergency stop, MRV, and evidence work; physical dispatch is intentionally unsupported |
| E — Passport | Implemented; browser acceptance still open | Canonical evidence, versioning, verification, and JSON/CSV/PDF exports exist; the corrected full Passport/PDF browser journey has not yet completed |
| F — Production readiness | In progress | Runtime assets and security controls exist, but target deployment, backup/restore, monitoring, and a green browser gate remain |
| Forecast/agent R&D | Library implemented; runtime integration deferred | Seasonal forecast, conservative clamp/plan, safety, risk, anomaly, explanation, learning, and agent-tool modules pass 309 tests, but are not connected to live telemetry, API routes, worker jobs, persistence, or the operator console |

## Implemented capabilities

### Foundation, database, and runtime

- pnpm workspace with strict TypeScript, Node 24, real ESLint configuration,
  truthful root migration/test scripts, dependency-first app builds, and
  frozen-lockfile container builds. API, worker, web, and Docker build paths
  rebuild config, engine, forecast, contracts, and database packages before
  consuming their published `dist` output.
- Drizzle schema plus reviewed SQL migration for all 26 tables and 12 enums.
  `pnpm db:migrate`, `pnpm db:check`, deterministic seed, and 24-hour
  simulation seed commands are implemented.
- PostgreSQL numeric and int8 values stay strings at precision-sensitive
  boundaries. Pool limits, startup-level statement timeout, redacted structured
  logging, and append-only trigger tests are in place.
- NestJS/Fastify API, standalone NestJS worker, and Next.js App Router web
  application have liveness/readiness or process health checks.
- API, worker, and web Dockerfiles plus
  `infra/runtime/docker-compose.pilot.yml` provide a local production-shaped
  Postgres → migrate → API/worker/web startup sequence.
- The worker uses PostgreSQL advisory locks and records a heartbeat. It polls
  enabled simulator connectors, recomputes eligible envelopes, propagates
  envelope/Passport staleness, sweeps quality, and cleans expired idempotency
  keys and export records.

### Authentication, authorization, and API safety

- One-time owner bootstrap, Argon2id password hashing, login, current-user,
  password change, logout, and rotating opaque refresh-token families with
  reuse detection are implemented.
- API routes are authenticated by default. Central RBAC and organization/facility
  scope checks protect facility data and actions.
- Helmet/CSP/HSTS, strict configured CORS, request IDs, bounded request bodies,
  per-session rate limits, tighter public-auth limits, contract-shaped errors,
  secure web cookies, and generic invalid-login responses are present.
- Connector configuration is authenticated encryption at rest and is never
  returned by connector APIs. Logger redaction and Docker context rules exclude
  credentials and private env files.
- Audit entries cover facility/configuration changes, connector operations,
  envelope recomputation, arming and drill transitions, emergency stop,
  Passport issuance, and exports.
- Mutating server actions refresh an expired access session once and retry the
  exact request body. This keeps emergency stop available when a long-running
  operator screen outlives the 15-minute access cookie; GET recovery remains a
  navigation redirect so Server Components never attempt to set cookies while
  rendering.

### Facilities, connectors, and telemetry

- Facility create/list/detail/update; immutable constraint version creation and
  history; flexibility mechanism create/update/list.
- Connector create/list/detail/update/test/sync history with encrypted
  configuration. The supported pilot types are `SIMULATOR` and
  `CSV_UPLOAD`; unsupported types are recorded but fail their readiness test
  instead of pretending to work.
- Idempotent JSON batch ingestion, exact-duplicate accounting, conflicting-row
  quarantine, timestamp/unit/size/row limits, and formula-safe CSV handling.
- CSV is preview-then-confirm with a short-lived token bound to the exact bytes.
- Telemetry series/latest views, freshness, expected-vs-observed completeness,
  maximum-gap calculation, quarantine review, source provenance, and explicit
  simulated-data flags.
- Capped telemetry queries retain the newest 5,000 samples, restore
  chronological display order, and disclose truncation. Replacing a previewed
  CSV immediately invalidates its prior commit-ready snapshot, including when
  the replacement is oversized or unreadable.

### Forecast and bounded-agent research layer

- The pulled `@gridflex/forecast` package implements seasonal-naive forecasts,
  envelope clamping, conservative reduction planning, deterministic safety and
  risk checks, anomaly detection, backtesting, numeric-grounded explanation,
  one-way conservative learning, and plan-bound agent tools.
- The package refuses incomplete inputs and cannot raise a claim above the
  deterministic assurance envelope. Its 309 database-free tests pass.
- This is not an active decision feature yet. Marketing and documentation label
  it as tested R&D because no API route, worker schedule, persistence model, or
  authenticated console workflow invokes forecasting, planning, or agent
  execution. A manual telemetry top-up script reuses only the package's
  explicitly simulated thermal/BESS source.

### Envelope

- Deterministic pure engine with conservative cap selection, safety limits,
  weakest-mechanism confidence, explicit blockers, methodology versioning, and
  complete reason-code/decision output.
- API and worker recomputation create engine runs and decisions, atomically
  version current envelopes, retain blocked attempts without erasing a valid
  current envelope, and expose current/history/explanation views.
- Scheduled recomputation requires 90% distinct one-minute coverage over 24
  hours plus fresh data. Stale data invalidates current envelopes and propagates
  Passport staleness.

### Drill, MRV, and evidence

- Facility-scoped drill planning and validation bind a plan to a current
  envelope and active safety-constraint version.
- Arming is a five-minute, single-use, operator-bound two-step challenge. The
  exact reviewed plan/constraints/envelope snapshot is checked again at confirm.
- Facility row locking prevents concurrent live drills. Start, normal stop,
  verification, abort, emergency stop, and explicit emergency-stop clearing are
  persisted as immutable events and audit records.
- Explicit simulated completion runs on a virtual clock, writes labelled
  telemetry, computes MRV, and seals a canonical evidence bundle in one
  transaction. A physical drill cannot enter this path.
- The MRV engine implements baseline selection/fallback, exact energy
  accumulation, missing-interval blocks, rebound reporting, and stable
  methodology versions. The canonical scenario remains within 240–250 kWh and
  9,600–10,000 bps across seeded runs.

### Passport, exports, reviewer surfaces, and UX

- Passport issuance enforces current-envelope, constraint-version, telemetry
  freshness/completeness, associated-drill MRV, and evidence-hash gates.
- Passport documents contain facility, envelope/mechanism provenance, safety
  limits, data quality, drill history, limitations, simulation labels, canonical
  evidence SHA-256, and canonical Passport SHA-256.
- Issuance is immutable and versioned; a new version supersedes older issued
  records without changing their canonical documents or hashes.
- Independent verification recomputes both Passport and evidence hashes.
- Export packages support canonical JSON, flattened formula-safe CSV, and a
  deterministic human-readable PDF. The PDF is deliberately a readable
  derivative and displays the canonical hashes; independent verification uses
  canonical JSON, not PDF bytes.
- The authenticated responsive console includes overview, telemetry, envelope,
  drills/proof chain, Passport/export, facility/safety, connectors, and audit
  surfaces. It includes loading/action states, keyboard command navigation,
  mobile navigation, copy affordances, plain-language blockers, and explicit
  confirmation for arming. Field-level errors move focus to the first invalid
  control; charts expose readable summaries and data tables; emergency stop is
  safely prefilled for one-action use; destructive connector disablement has a
  named consequence review; and verified colour/language is reserved for
  evidence that has actually passed verification. Noncritical source-label
  enrichment fails soft instead of hiding the workspace, the drill form is
  visibly locked to simulation-only mode, and primary-link hover contrast
  retains its accessible ink colour.

## Honest remaining work

### Active release blockers

1. Obtain explicit approval/usage availability, then run the definitive
   production-build-backed 15-check Playwright suite. The approval reviewer
   rejected the latest launch because of an account/tool-usage limit and
   explicitly prohibited an automatic retry or workaround.
2. Confirm the complete Passport journey reaches issuance, canonical JSON and
   PDF downloads, and hash verification. The latest diagnostic timed out on a
   transient plan-created status before reaching Passport; the harness now
   waits for the durable ledger row, but that correction is unexecuted.
3. Preserve the latest diagnostic evidence accurately: session refresh and the
   emergency-stop path passed; stale telemetry showed the intended actionable
   blocker; and malformed drill input rendered the custom 404 state without an
   internal error. The three failing assertions were harness/contract
   mismatches, but their corrections must not be reported as passing until run.
4. Rerun the 9 PostgreSQL append-only tests and 40 PostgreSQL-backed API tests
   after the final safety hardening. Their earlier release runs passed, while
   the current database-free safety/export suites pass 12 of 12; access to the
   local Docker database was rejected by the same approval/tool-usage limit.
5. Run the 16 pulled forecast PostgreSQL integration tests against the same
   isolated local database. They cover approval-gated agent execution, refused
   no-write behavior, emergency stopping, and safety telemetry provenance.
6. Rebuild and inspect the three production container images after the
   main-branch sync. The full production workspace build passes, and the earlier
   images passed secret-exclusion inspection, but those exact images predate the
   pulled forecast package.

### Required before the first external pilot

1. Deploy the exact API/worker/web images to the target Coolify project, apply
   the reviewed migration once, run `pnpm db:check`, and execute the complete
   simulator → envelope → drill → MRV → Passport → JSON/PDF download → hash
   verification journey there.
2. Configure automated PostgreSQL backups, take a pre-release backup, complete
   and record a restore drill, and rotate any credentials that have previously
   been shared.
3. Configure persistent storage/retention, TLS domains, alert delivery, and
   dashboards for API readiness, worker heartbeat, telemetry staleness,
   connector degradation, failed engine runs/exports, disk pressure, and failed
   backups.
4. Render and visually inspect the pilot PDF artifact. Deterministic bytes and
   PDF structure are covered by tests, but there is not yet a pixel-level PDF
   snapshot suite. The current dependency-free report is not the specification's
   Playwright HTML-to-PDF, fixed eight-section presentation; either bring that
   counterparty artifact to the prescribed design and snapshot gate or record an
   explicit pilot waiver before external use.
5. Run the browser suite in the deployed environment at supported desktop and
   mobile widths and complete a short operator usability rehearsal.

### Deliberate product boundary / later work

- No real BMS/DCIM/cloud/vendor polling adapters are implemented. The pilot uses
  deterministic simulator telemetry or operator-reviewed CSV/JSON ingestion.
- No production dispatch, hardware control, market settlement, or blockchain
  dependency exists. GridFlex records and verifies evidence; it does not actuate
  facility equipment.
- The forecast/agent layer pulled from `main` is a tested library, not an
  operating product surface. Wiring it to telemetry, workload schedules,
  persistence, API/worker orchestration, approvals, and the console remains
  later work and must retain deterministic envelope and emergency-stop
  subordination.
- Tested/observed mechanism caps are supported by the pure engine but are not
  yet derived from historical drills and promoted into application envelope
  inputs.
- Organization membership/invitation administration and reviewer-note workflow
  are not exposed as pilot UI/API flows.
- The convenience routes `GET /envelopes/:id` and
  `GET /passports/:id/pdf` are implemented. The console continues to prefer the
  audited export-package workflow so counterparty exports retain lifecycle and
  audit metadata.
- Export bytes are rendered on demand from immutable Passport records and the
  package metadata uses `database://` URIs. There is no S3/object-storage
  adapter yet; add one before export volume or retention requirements exceed a
  single-pilot deployment.
- API controllers/services and worker jobs use typed Drizzle queries directly;
  the optional `packages/db/repositories` abstraction described in the spec was
  not introduced. This is maintainability debt, not a pilot runtime blocker.
- PostgreSQL integration tests use a configured local database rather than
  provisioning an isolated Testcontainer automatically.

## Reproducible verification

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck

# Load a local, non-production DATABASE_URL before database-backed checks.
pnpm db:migrate
pnpm db:check
pnpm db:seed
pnpm test

# Requires the API and web test servers configured by Playwright.
pnpm test:e2e
```

Deployment, rollback, health interpretation, alerting, and incident actions are
documented in `docs/pilot-deployment-runbook.md`.
