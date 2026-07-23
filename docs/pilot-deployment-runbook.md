# GridFlex pilot deployment runbook

This runbook is the release path for a single-customer pilot. It deploys three
separate processes—web, API, and worker—against one PostgreSQL database. The
worker has no public port. Never use the local compose credentials in Coolify.

## 1. Release gate

From a clean checkout with Node 24 and pnpm 10.28:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
# This explicitly rebuilds config, engine, forecast, contracts, and db before any app.
pnpm build
pnpm test:e2e
```

`pnpm test:e2e` is intentionally strict: it fails if the web package does not
define or cannot execute its browser suite. A green command must never mean “no
test script was found.”

Do not substitute an internal app-only compiler command for `pnpm build`.
Workspace packages publish through `dist`, so a stale contracts build can make
an app reject capabilities that exist in source. For a single image, use the
root `pnpm build:api`, `pnpm build:worker`, or `pnpm build:web` command; the
Dockerfiles use those same dependency-first paths.

## 2. Local production-shaped smoke test

```bash
cp infra/runtime/pilot.env.example infra/runtime/pilot.env
# Replace every placeholder with local-only random values.
docker compose --env-file infra/runtime/pilot.env \
  -f infra/runtime/docker-compose.pilot.yml up --build -d
docker compose --env-file infra/runtime/pilot.env \
  -f infra/runtime/docker-compose.pilot.yml ps
```

Expected state: `postgres`, `api`, `worker`, and `web` are healthy; `migrate`
exited successfully. Verify `http://localhost:4000/api/v1/health/ready` reports a
database revision and a recent `worker_last_seen`. Verify the browser at
`http://localhost:3000` before pilot use.

To exercise the worker once during a release without leaving a scheduler
running:

```bash
WORKER_RUN_ONCE=true pnpm --filter @gridflex/worker dev
```

This polls only connectors explicitly typed `SIMULATOR`; it never writes
synthetic data for a real connector. Simulated rows carry `simulated: true` and
the engine simulator version in metadata.

## 3. Coolify resources

Create `gridflex-api`, `gridflex-worker`, and `gridflex-web` in the same Coolify
project/destination as PostgreSQL. Use repository root as build context and:

| Resource | Dockerfile | Port / health |
|---|---|---|
| API | `apps/api/Dockerfile` | `4000`, `/api/v1/health/ready` |
| Worker | `apps/worker/Dockerfile` | no public port; container DB heartbeat check |
| Web | `apps/web/Dockerfile` | `3000`, `/` |

Mount the same persistent volume at `/data/gridflex` in API and worker. Set
`API_INTERNAL_BASE_URL` on web to the private API URL ending in `/api/v1`.
`NEXT_PUBLIC_API_BASE_URL` is a build argument and must be the browser-reachable
HTTPS API URL. Set `CORS_ORIGINS` on API to the exact web origin.

Required secrets are `DATABASE_URL`, `AUTH_SECRET`, and
`CONNECTOR_ENCRYPTION_KEY`. The two application secrets must be different and at
least 32 characters. Also set `APP_ENV=production`, `LOG_LEVEL=info`,
`STORAGE_ROOT=/data/gridflex`, and a unique `WORKER_INSTANCE_ID`.

## 4. Migration and cutover

1. Confirm a restorable PostgreSQL backup and record its identifier.
2. Build all three images from the same commit SHA.
3. Deploy the API image without switching traffic when the platform allows it.
4. Run `pnpm db:migrate` once from that image.
5. Run `pnpm db:check`; stop the release if it reports drift.
6. Deploy worker, then wait for `worker_last_seen` to advance twice.
7. Switch API and web traffic.
8. Run the owner/facility, simulator ingestion, envelope, drill, Passport, JSON,
   CSV and PDF export, and hash-verification pilot journey.

Never run `drizzle-kit push`. Never apply an unreviewed reverse migration during
an incident. Roll back application images when the schema remains compatible;
otherwise restore the pre-migration backup into a controlled recovery window.

## 5. Operational checks

- Alert if API readiness is degraded or worker heartbeat is older than 90 seconds.
- Alert on connector `ERROR`/`DEGRADED`, telemetry older than 15 minutes,
  envelope `STALE`, repeated failed engine runs, failed exports, disk pressure,
  and failed backups.
- The worker uses PostgreSQL advisory locks, so multiple replicas are safe but
  do not increase job throughput. Start with one replica for a pilot.
- Export cleanup deletes only expired local files resolved beneath
  `STORAGE_ROOT`; remote object URIs are never deleted by the worker.
- Scheduled envelope recomputation requires at least 90% distinct one-minute
  coverage over 24 hours and a reading within the last 15 minutes. On-demand API
  recomputation remains the operator path when a facility is not eligible.
- JSON, formula-safe CSV, and deterministic PDF Passport exports are supported.
  Treat the PDF as a readable derivative: independently verify the canonical
  JSON and evidence hashes rather than hashing the PDF bytes.

## 6. Incident actions

If telemetry goes stale, the worker marks the current envelope `STALE` and
supersedes Passports tied to non-current envelopes. Restore ingestion, inspect
quality, and recompute before continuing a drill. For any safety alarm or
unexpected drill state, use the application emergency stop, retain the audit
trail, and keep control with the facility operator.

Rotate any credential ever pasted into chat or logs before the first external
pilot. After cutover, perform and document one restore drill from the Coolify
backup before representing the environment as pilot-ready.
