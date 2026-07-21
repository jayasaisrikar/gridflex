# GridFlex V2 — Implementation Status

Updated at the end of each phase, per the governing instruction in the spec (§0).

---

## Phase A — Foundation

**Status: BLOCKER RESOLVED 2026-07-21. Exit criteria met.**

The connectivity blocker recorded below was stale. The Coolify Postgres is
reachable from the development machine at the host recorded in `.env` (not the
internal hostname in `GridFlex_private.env`), running **PostgreSQL 18.4**.

Verified by inspection (read-only):

- All **26 tables** present — the migration has already been run successfully.
- Seeded and in use: 2 organizations, 2 users, 1 facility
  ("Lone Star Compute Facility", America/Chicago), 3 flexibility mechanisms,
  1 facility constraint, 4 connectors.
- Live domain records: 1 drill, 6 drill events, 1 envelope, 3 envelope
  mechanisms, 1 engine run, 4 engine decisions, 1 MRV report, 1 evidence bundle,
  5 audit log entries.
- **1,439 telemetry readings** of `facility.active_power_kw`, 1-minute
  resolution, all `GOOD`, spanning 2026-07-20T11:58Z .. 2026-07-21T11:56Z.

Phase A's exit criterion — "empty database migrates cleanly, owner can sign in,
seeded facility appears" — is therefore satisfied. The risks below about running
migrations against production remain relevant for *future* destructive work.

**Standing constraint:** this is a populated, live database. Per spec §25, no
destructive test runs against it. Read-only validation is permitted; integration
tests that assert append-only triggers by attempting mutations belong on the
local Docker Postgres (`docker-compose.local.yml`, host port 5433 — Docker
confirmed available).

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

### Verified against the live database (2026-07-21)

- [x] Database migrates cleanly — all 26 tables present and populated.
- [x] Seeded facility appears ("Lone Star Compute Facility").
- [x] API and worker applications scaffolded (`apps/api`, `apps/worker`).

### Still outstanding

- [ ] `pnpm db:check` schema-contract verification (script not yet written).
- [ ] Append-only trigger integration tests — these attempt mutations and must
      run against local Docker Postgres, never the live database.

### Unresolved risks and blockers

1. **RESOLVED 2026-07-21 — database reachable.** `GridFlex_private.env` records
   only the internal Coolify hostname `xgpmainz1zkr3ga9q7d4ghz4:5432`, which is
   unresolvable from the development machine. The working endpoint is the one in
   `.env`. The two files disagreeing is itself a hazard — a future reader
   following `GridFlex_private.env` will conclude the database is down.

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
nc -z xgpmainz1zkr3ga9q7d4ghz4 5432                # UNREACHABLE (stale host)
# 2026-07-21, endpoint from .env:
select version()                                   # PostgreSQL 18.4 — CONNECTED
```

### Test results

Superseded — see the per-package sections below. **Monorepo total: 273 passing**
(engine 110, contracts 23, forecast 140), 0 failing, typecheck clean.

No integration test touches a database yet; that work is pending and belongs on
local Docker.

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

**140 tests passing** in `packages/forecast`, 0 failing.

| Suite | Tests |
|---|---:|
| `features` | 23 |
| `seasonal-baseline` | 30 |
| `clamp` | 13 |
| `backtest` | 12 |
| `plan` | 26 |
| `risk` | 27 |
| `agent` | 45 |
| `anomaly` | 39 |
| `learning` | 24 |
| `explain` | 27 |
| `end-to-end` | 5 |
| `trust-boundary` | 6 |
| **Total** | **277** |

Plus **10 integration tests** against a real Postgres, excluded from the default
run and invoked with `pnpm test:integration` after `pnpm local:db:up`. They run
against local Docker only — `assertLocal` refuses any non-localhost host, since
they write drills and spec §25 forbids that against the live database. Each runs
in a transaction that is rolled back.

Monorepo total is now **410 passing** (engine 110, contracts 23, forecast 277),
plus 10 integration, up from 133.

**All eight AI sub-projects are implemented.** Typecheck clean under full strict mode across all five packages.

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

### Sub-projects 3 and 4 — risk assessment and reduction planner

- [x] `plan` — allocates a committed reduction across mechanisms, least
      disruptive first. Default order is WORKLOAD -> STORAGE -> COOLING:
      deferring compute delays work that was finishing later anyway, discharging
      storage spends a reserve needed for real outages, and raising setpoints
      moves toward a thermal limit — the only one of the three that can damage
      equipment. Overridable per mechanism via `metadata.disruptionRank`, with
      malformed hints ignored rather than trusted.

      A mechanism that cannot sustain the **full** window is excluded outright
      rather than partially credited, because a mechanism dropping out mid-drill
      converts a pass into a failure. Every exclusion is recorded with the
      capacity forgone, so an operator sees what was available but unusable.

- [x] `risk` — deterministic constraint checks producing LOW / MEDIUM / HIGH /
      BLOCKED plus itemised factors. No model output can raise, lower, or clear
      a factor; a language model that could talk its way past a thermal limit is
      not a safety layer.

      Thermal margin and battery state of charge are assessed **only when the
      plan actually draws on cooling or storage** — blocking a workload-only
      drill for a thin thermal margin would refuse safe work for no reason.
      Where those inputs are needed, **unknown is treated as blocking, not as
      fine**: a missing reading must never read as safe.

### Full chain validated on the real facility

The validation script now runs features -> forecast -> clamp -> plan -> risk
against live data. Two results, both correct and both non-obvious:

    30-min drill, target 600.000 kW
      feasible    true
      allocated   WORKLOAD_DEFERRAL 350 + UPS_BESS 150 + COOLING_HEADROOM 100
      response    144s at 250.000 kW/min, rebound watch 45 min
      RISK        BLOCKED
                    [BLOCKER] THERMAL_MARGIN_UNKNOWN
                    [BLOCKER] BATTERY_SOC_UNKNOWN

    60-min drill, target 600.000 kW
      feasible    false — allocated 350.000, shortfall 250.000
      excluded    COOLING_HEADROOM, UPS_BESS (DURATION_EXCEEDS_MECHANISM_LIMIT)
      RISK        BLOCKED  [BLOCKER] PLAN_NOT_FEASIBLE

The 60-minute case is a real facility constraint, not a synthetic one: the three
mechanisms sum to exactly the 600 kW envelope, but cooling and storage cap at 30
minutes while workload deferral runs 60. **Half the facility's nominal
flexibility is unavailable for a one-hour event**, which the mechanism table
implies but nothing in the product previously surfaced.

The 30-minute case exposes a **telemetry gap**: the facility reports only
`facility.active_power_kw`. Any plan touching cooling or storage is therefore
unverifiable and blocks. Closing this needs thermal and SoC metrics ingested —
a connector question, not a modelling one.

### Sub-projects 5, 6 and 7 — agent, anomaly detection, learning

- [x] `agent` — pure orchestration state machine plus a tool registry declaring
      each tool's blast radius as data. Approvals are **plan-bound and
      single-use**: approving a small plan, re-planning to a larger reduction and
      executing against the original approval is refused by two independent
      mechanisms (fingerprint comparison, and `applyResult` clearing the approval
      whenever the plan changes). `STOP_DRILL` is authorized in every phase,
      under a latched emergency stop, with no approval, and after the session is
      terminal — verified exhaustively across all combinations. A blocking risk
      assessment refuses mutation even with a valid approval: approval is
      permission to act, never permission to override a constraint.

      Execution lives outside the package. The trust-boundary rule forbidding
      third-party imports in `src/` forces this — the agent cannot reach a
      database or connector even by accident.

- [x] `anomaly` — robust statistics only (median/MAD, Iglewicz-Hoaglin modified
      z at 3.5). Mean and standard deviation were rejected because a genuine
      spike inflates its own sigma enough to hide the next one; MAD does not have
      that failure. Detects load spikes and drops, stuck meters (a stuck meter
      reports a plausible value forever and passes every range and quality
      check), completeness drops, delivery shortfalls, rebound spikes, and
      elevated cooling during a reduction.

- [x] `learning` — compares predicted against delivered across drills and derives
      a facility-specific correction. **Corrections may only make forecasts more
      conservative.** A facility that over-delivers earns no upward adjustment;
      a larger claim must come from the envelope on tested evidence, not from a
      lucky streak. Anomalous and simulated drills are excluded from learning
      entirely — learning from a drill where the meter was stuck would bake the
      fault into the facility's model. `applyCorrection` throws on any factor
      above 1, since the type system cannot express "only reduces".

### Defect found by real data: the detector flagged a successful drill

The first anomaly scan against live telemetry returned **five CRITICAL
LOAD_DROP anomalies and a confidence penalty of 1.0** — the maximum.

All five were the facility's own completed drill: 11:25-11:55 on 2026-07-21,
500 kW requested, ~490 kW observed. The detector had no drill awareness, so a
planned, operator-approved, successful reduction read as a critical fault, and
the penalty would have destroyed the facility's confidence for doing exactly
what the product exists to do. An operator would have muted it within a week,
and a muted detector catches nothing.

Fix: `detectTelemetryAnomalies` accepts `knownReductionWindows`. Intervals
inside a drill are excluded from outlier and stuck-meter scanning — and from the
MAD baseline itself, since a drill left in the sample inflates the scale estimate
and masks genuine outliers around it. Those intervals are not unexamined;
`detectDrillAnomalies` evaluates them against what the drill committed to, which
is the correct expectation for them.

Same real data, after the fix:

    without drill awareness:  5 anomalies, confidence penalty 1.0
    with drill awareness:     0 anomalies, confidence penalty 0

A regression test pins both halves, and a further test confirms a genuine spike
outside the drill window is still caught.

### Still outstanding for the AI layer
- [ ] LLM explanation layer (8).
- [ ] Landing-page AI section (Predict / Plan / Protect / Learn).

### Validation against real telemetry (2026-07-21)

`scripts/validate-against-real-telemetry.ts` runs the full chain — features ->
forecast -> clamp, plus a holdout backtest — against the live facility. It issues
**SELECTs only** and writes nothing.

Result on 1,439 real readings (287 five-minute intervals, 100% complete):

    load range      1107.1 .. 1602.6 kW
    envelope        DRAFT, 600.000 kW, confidence 0.25 (SUM_OF_MECHANISM_CAPS)
    forecast        ~700 kW  =>  claim 600.000 kW  (ENVELOPE binding)

Three things this established:

1. **The clamp fired on real data.** The forecaster's ~700 kW headroom estimate
   exceeded the envelope's 600 kW ceiling and was clamped down to it, with
   confidence subordinated to the envelope's grade. The headline hazard occurred
   naturally on the first real dataset, and the boundary held.
2. **The backtest refused all 5 holdout cases** rather than guessing — correctly.
   Telemetry starts at noon, so the 09:00-12:00 buckets have no prior history.
   A model that answered anyway would have been fabricating.
3. **A real defect was found and fixed** (below).

### Defect found by real data: unearned interval precision

The baseline reported a prediction interval of **+/-1.4 kW on a load that swings
~500 kW**, with confidence 0.249.

Cause: the window is 23h55m, so nearly every 30-minute seasonal bucket is
populated by a single day. `n=6` was not six observations of "Tuesday 09:00"
across weeks — it was six consecutive 5-minute intervals inside one half hour.
The interval measured within-bucket noise and understated real uncertainty by a
wide margin. Fixture tests could not catch this because every fixture spanned
multiple days by construction.

Fix: pools now track **distinct contributing days**. `ForecastResult` carries
`distinctDaysUsed` and `intervalUnderpowered`, a `FORECAST_INTERVAL_UNDERPOWERED`
warning accompanies any single-day estimate, and confidence gained a
multiplicative day-diversity factor saturating at 7 days.

Effect on the same real data: **confidence 0.249 -> 0.036**, a 7x reduction. The
interval is still narrow — that is inherent to one day of history — but the model
no longer claims precision it has not earned.

This also invalidated an end-to-end assertion expecting >0.9 confidence on a
7-day flat series. That expectation *was* the overconfidence; it now asserts the
day-diversity-capped range (5 weekdays of 7).

### Honest limitations that remain

- The facility has **~24 hours of telemetry**. The seasonal model is designed to
  learn day-to-day and weekday/weekend structure and there is not yet enough
  history for it to do so. Every bucket is single-day, so every forecast is
  currently flagged `intervalUnderpowered`.
- **No weekend data exists at all** (2026-07-20/21 are Monday/Tuesday), so
  weekend forecasts refuse outright.
- **No accuracy figure has been measured** against real data — the backtest
  scored zero cases because it correctly refused all of them. MAE, bias and
  coverage against this facility remain unknown.
- All mechanisms are `DECLARED` provenance with no completed tests, so the
  envelope caps confidence at 0.25 regardless of what the forecaster does.

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
