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
