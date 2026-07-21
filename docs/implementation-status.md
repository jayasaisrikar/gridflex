# GridFlex V2 — Implementation Status

Updated at the end of each phase, per the governing instruction in the spec (§0).

---

## Phase A — Foundation

**Status: IN PROGRESS — blocked on database connectivity.**

### Completed acceptance criteria

- [x] pnpm workspace monorepo (`apps/*`, `packages/*`) per spec §5.
- [x] `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`,
      `exactOptionalPropertyTypes`, `useUnknownInCatchVariables` (§4.1).
- [x] Node 24 pinned via `.nvmrc` and `engines` (installed: v24.18.0).
- [x] `git init` with `.gitignore` excluding all `.env` files, committed **before**
      any other file, so `GridFlex_private.env` never entered history.
- [x] `packages/config` — env parsing with Zod; enforces
      `CONNECTOR_ENCRYPTION_KEY != AUTH_SECRET` (§18); logger with redaction of
      passwords, tokens, connection URLs, connector secrets, and raw telemetry (§18).
- [x] `packages/db` — Drizzle definitions for all 24 tables and 12 enums,
      names matching `gridflex_schema.sql` exactly (§7).
- [x] Authoritative SQL copied verbatim to
      `packages/db/drizzle/0000_initial_gridflex.sql` with a Drizzle journal entry (§7).
- [x] `pg` numeric (OID 1700) and int8 (OID 20) type parsers return **strings**,
      not JS numbers, preserving precision (§6.1).
- [x] Pool configured `max: 10`, `idleTimeoutMillis: 30_000`,
      `connectionTimeoutMillis: 5_000`, `statement_timeout = 30s` (§6.1, §7.4).
- [x] `drizzle.config.ts` documents the `push` prohibition (§4.1).
- [x] `typecheck` passes clean for `@gridflex/config` and `@gridflex/db`.

### NOT yet met (require a reachable database)

- [ ] Empty database migrates cleanly (`pnpm db:migrate`).
- [ ] `pnpm db:check` schema-contract verification (script not yet written).
- [ ] Append-only trigger integration tests.
- [ ] Owner bootstrap endpoint and sign-in.
- [ ] Seed command producing the canonical facility.
- [ ] API and worker applications (not yet scaffolded).

**Phase A is explicitly NOT complete.** The exit criterion — "empty database
migrates cleanly, owner can sign in, seeded facility appears" — is unverified.

### Unresolved risks and blockers

1. **BLOCKER — database unreachable.** `GridFlex_private.env` contains only the
   internal Coolify hostname `xgpmainz1zkr3ga9q7d4ghz4:5432`, which does not
   resolve from the development machine and is TCP-unreachable. No public
   endpoint is recorded in the file. Awaiting the exposed host:port from the
   operator.

2. **RISK — production database as development target.** The operator has
   directed that the Coolify production Postgres be used directly. Spec §25
   states: *"Do not point local experiments at the production database."*
   Phase A normally involves repeated migration runs, and §19.2 requires
   integration tests that assert append-only triggers by attempting mutations.
   Mitigation proposed, not yet agreed: run schema migration against Coolify as
   a single controlled, backed-up run; keep destructive integration tests on a
   local Docker Postgres (`docker-compose.local.yml`, host port 5433).

3. **RISK — no database backup configured.** Spec §18 and §22 require a backup
   before every destructive migration. Not yet configured; must be done before
   the first Coolify migration run.

4. **RISK — credential rotation outstanding.** Per §18 and `README_FIRST.md`,
   the database password was shared in conversation and must be rotated after
   first successful deployment.

### Commands run

```bash
node --version                  # v22.22.2 initially -> v24.18.0 after nvm install 24
nvm install 24                  # -> v24.18.0
git init && git commit .gitignore   # secrets excluded before any other commit
pnpm install                    # 105 packages, exit 0
pnpm --filter @gridflex/config exec tsc --noEmit   # clean
pnpm --filter @gridflex/db     exec tsc --noEmit   # clean
nc -z xgpmainz1zkr3ga9q7d4ghz4 5432                # UNREACHABLE
```

### Test results

No test suites exist yet. `vitest` is installed and wired into package scripts.
Tests will be written before Phase A is marked complete, per the governing
instruction ("Implement tests before marking a phase complete").

**Current test count: 0. No passing-test claim is being made.**

---

## Assurance engine (`packages/engine`) — spans Phases B, D, E

Built ahead of sequence because it is framework- and database-independent, and
was therefore not blocked by the connectivity issue above.

### Completed

- [x] `units` — exact bigint arithmetic. Power in milli-kilowatts, energy in whole
      watt-hours. No certified value passes through floating point (§14).
- [x] `canonical-json` — recursive key sorting, UTC RFC 3339 normalization,
      decimals as strings, SHA-256 over canonical bytes (§15.1). Rejects
      non-integer and non-finite numbers rather than producing a document whose
      hash is not portable.
- [x] `mrv` — median-of-5-eligible-days baseline with 12-interval fallback;
      delivery and performance per §14 formulas; rebound reported separately and
      never netted off; missing intervals contribute zero and are recorded as
      quality blocks, never interpolated.
- [x] `simulator` — seeded mulberry32 PRNG producing byte-identical output for a
      given seed (§11), with fault injection for stale telemetry, missing
      intervals, and thermal violation.
- [x] **Canonical scenario acceptance gate passes** (§14, Phase D exit):

      committed          250 kWh
      delivered          244.724 kWh    (spec 240-250)      PASS
      performance        9789 bps       (spec 9600-10000)   PASS
      average delivered  489.447 kW     (spec ~490)         PASS
      completeness       1.0

      Driven end to end by the simulator and MRV engine — not hardcoded. Also
      verified to hold across 25 different seeds.

### Notable finding

A precision defect was caught by test, not by review: converting each interval to
watt-hours and summing the rounded results **overstates a 30-minute 490 kW drill
by 10 Wh**, because 490 kW x 60 s = 8166.67 Wh rounds up every interval. That
error would have landed in a certified Passport. `computeMrv` accumulates exact
mkW-seconds and converts once; the hazard is now pinned by the regression test
`"per-interval rounding DRIFTS"` and documented at the accumulation site.

- [x] `envelope` (§12) — cap selection `min(declared, observed, constraint)`,
      physical-headroom and curtailment caps, provenance promoted only on real
      evidence (TESTED requires an actual test), confidence derived from the
      **weakest** mechanism with every adjustment itemised, hard 0.95 cap
      pending external review. Blocked envelopes assert zero capacity and record
      a BLOCKER decision with the numbers that caused it.
- [x] `drill/state-machine` (§13) — pure transition evaluation. Emergency stop
      preempts arming and starting but **never** blocks ABORT / FAIL / CANCEL,
      so a live drill can always be brought down. All applicable refusals are
      returned together rather than one at a time.

### Still outstanding for these phases

- [ ] Evidence bundle and Passport assembly — §15.
- [ ] PDF rendering and snapshot tests — §15.3.
- [ ] Arming challenge issue/consume logic (schema and contract exist; the
      stateful single-use/expiry enforcement belongs in the API).

---

## `packages/contracts` — shared Zod schemas (§9)

### Completed

- [x] Primitives — UTC timestamps reject non-`Z` offsets so everything stored and
      hashed is unambiguously UTC (§4.1); decimals cross the API boundary as
      strings; power limited to 3 decimal places to match `numeric(14,3)`.
- [x] Closed set of stable error codes plus the §9 error envelope. Spec §4.1
      forbids branching on message text, so the code is the contract.
- [x] Telemetry batch validates each reading's unit **against the canonical
      metric** rather than coercing — a MW/kW mix-up would silently corrupt every
      downstream calculation.
- [x] RBAC permission matrix encoded once, consumed by both the API guard and the
      web UI, so the two cannot disagree about who may do what.
- [x] Facility, constraint, mechanism, envelope, drill, MRV, and Passport schemas.
- [x] Passport schema carries `contains_simulated_data` **inside the hashed
      document**, so a simulated Passport cannot be laundered into looking real.

### Test results

**23 tests passing.** Typecheck clean.

### Commands run

```bash
pnpm -r --filter './packages/*' exec tsc --noEmit       # clean
pnpm -r --filter './packages/*' exec vitest run         # 133 passed
```

### Test results

**133 tests passing, 0 failing** across 7 files:

| Suite | Tests |
|---|---:|
| `engine/units` | 20 |
| `engine/canonical-json` | 18 |
| `engine/mrv` | 13 |
| `engine/canonical-scenario` | 13 |
| `engine/envelope` | 24 |
| `engine/drill-state-machine` | 22 |
| `contracts/contracts` | 23 |
| **Total** | **133** |

Typecheck clean under full strict mode across all four packages.

---

## AI layer (`packages/forecast`) — new, spans a planned Phase G

Added on 2026-07-21. The AI capability set (forecasting, planning, risk,
agentic orchestration, anomaly detection, learning, explanation) was found to be
**entirely unimplemented** — the platform was telemetry and reporting only, with
zero AI dependencies anywhere in the tree.

That scope decomposes into eight sub-projects. This entry covers the first two.

### Design decisions taken

1. **Versioned forecaster interface over a TypeScript baseline.** No Python
   sidecar. `FlexibilityForecaster` is an interface; the seasonal-naive baseline
   is one implementation, and a gradient-boosted model can be another without
   touching consumers. The backtest harness is the instrument that decides when
   that swap is justified — by measurement, not assumption.
2. **Planning at mechanism granularity.** The schema has no workload/job table.
   Rather than inventing one for a connector that does not exist yet, planning
   will use `flexibility_mechanisms` and read optional workload hints from the
   existing `metadata` jsonb. A real table gets designed from a real payload.
3. **Forecast confidence strictly subordinate to envelope confidence.** See below.

### The trust boundary

The governing constraint is that a statistical model must never be able to raise
a claim above what the certified assurance layer supports:

    claimed_kw         = min(forecast_kw, envelope_kw)
    claimed_confidence = min(model_confidence, envelope_confidence)

and a BLOCKED envelope forces a zero claim regardless of model output.

This is enforced structurally, not by convention. `packages/engine` does not
depend on `packages/forecast`; the arrow points one way only. Four tests in
`tests/trust-boundary.test.ts` read the source tree and fail if that reverses,
if the forecast package reaches MRV/Passport/evidence/canonical-json, if it
acquires a third-party runtime dependency, or if any module other than the clamp
emits a user-facing `claimed*` field.

### Completed

- [x] `features` — resamples raw `telemetry_readings` onto a fixed interval grid.
      Only `GOOD` readings are admitted; the interval value is the exact **median**
      of its samples, so a single stuck-high meter cannot move a feature the way
      it would move a mean. **Gaps are never interpolated** — the same refusal the
      MRV engine makes (§14) — and `NO_READING` is distinguished from
      `QUALITY_EXCLUDED` because those imply different operational fixes.
- [x] `forecast/types` — the `FlexibilityForecaster` contract, horizons of
      15/30/60 min, and a completeness gate set to 0.9 to match the envelope
      engine's §10.2 gate, so the two layers refuse on the same evidence.
- [x] `forecast/seasonal-baseline` — empirical quantiles over
      (weekday|weekend, 30-min bucket) pools. Quantiles use nearest-rank, so
      every output is a load level the facility has actually run at rather than a
      synthetic midpoint. Reducible power is headroom above the minimum safe
      load, and the **lower** bound derives from the **low** load case, because
      low load is when the safe floor is nearest. Confidence compounds three
      penalties — incompleteness, thin seasonal pool, and interval width relative
      to the estimate — so a model that does not know says so.
- [x] `forecast/clamp` — the subordination described above, with both raw inputs
      retained for diagnostics but explicitly marked not-for-display.
- [x] `backtest` — replays historical windows and scores accuracy (MAE, signed
      bias) **and interval coverage** separately. Coverage is the load-bearing
      metric: a model with excellent MAE and 40% coverage on an 80% interval is
      lying about its own uncertainty, which is the more dangerous failure once
      confidence propagates into operator-facing claims.

### Test results

**83 tests passing** in `packages/forecast`, 0 failing.

| Suite | Tests |
|---|---:|
| `features` | 23 |
| `seasonal-baseline` | 26 |
| `clamp` | 13 |
| `backtest` | 12 |
| `end-to-end` | 5 |
| `trust-boundary` | 4 |
| **Total** | **83** |

Monorepo total is now **216 passing** (engine 110, contracts 23, forecast 83),
up from 133. Typecheck clean under full strict mode across all five packages.

The clamp suite includes an exhaustive grid over 7 forecast values x 6 envelope
values x 7 model confidences x 7 envelope confidences (2,058 combinations)
asserting the claim never exceeds either input and never goes negative.

`end-to-end.test.ts` drives raw readings through features, forecast and clamp
against the **real** `computeEnvelope`, not a stub — the clamp takes a structural
`EnvelopeCeiling` to stay decoupled, so nothing else would prove the two shapes
actually line up.

### Notable finding

The trust-boundary test failed on first run and the defect was in the test, not
the code: the import scanner matched ordinary prose inside a doc comment
(`... tell "500 kW" from "we guessed 500 kW" ...`) as an import statement. An
architectural test that reports phantom violations gets ignored, and an ignored
boundary test is worse than none. The scanner now strips comments first.

### Still outstanding for the AI layer

- [ ] Risk assessment agent (sub-project 3).
- [ ] Reduction planner over mechanisms (4).
- [ ] Agent orchestration and tool surface (5) — **requires a database**.
- [ ] Anomaly detection (6).
- [ ] Learning loop over completed drills (7) — **requires a database**.
- [ ] LLM explanation layer (8).
- [ ] Landing-page AI section (Predict / Plan / Protect / Learn).

### Honest limitation

Everything above is fixture-driven and unit-tested. **None of it has been
exercised against a real database or real facility telemetry**, because Phase A
remains blocked on connectivity (see below). The seasonal baseline has never seen
a real load curve. No claim is being made that this is validated against
production data — only that its logic is correct and its boundaries hold.

---

## Phases B–F

The pure domain layer is substantially built. Not yet scaffolded:

- `apps/api` — NestJS + Fastify, validation pipe, guards, modules, health.
- `apps/worker` — standalone NestJS context, advisory-lock jobs.
- `apps/web` — Next.js App Router UI (§16).
- `packages/db/repositories` and `scripts/` (`seed.ts`, `check-schema.ts`).
- Evidence bundle and Passport assembly (§15), PDF rendering (§15.3).
- All integration and E2E tests (§19.2, §19.3) — these require a database.

**No phase has been formally completed.** Phase A's exit criterion remains
unverified because no migration has been run against any database.
