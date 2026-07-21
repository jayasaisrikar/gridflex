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

## Phases B–F

Not started.
