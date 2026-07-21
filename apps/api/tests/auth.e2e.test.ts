/**
 * Auth integration tests (spec §8.2, §19.2).
 *
 * Runs the real NestJS + Fastify application against the real database using
 * Fastify injection — no HTTP listener, no mocks of the security-critical paths.
 * Argon2id hashing, JWT verification, and refresh rotation all execute for real.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { AppModule } from '../src/app.module.js';
import { ErrorFilter } from '../src/common/errors/error.filter.js';

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv(): void {
  const text = readFileSync(resolve(here, '../../../.env'), 'utf8');
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index);
    if (!process.env[key]) process.env[key] = line.slice(index + 1);
  }
}
loadEnv();

/**
 * These tests run against a DISPOSABLE database, never a real one.
 *
 * They need an empty `app_users` table to exercise the bootstrap path, and
 * clearing it is impossible on a protected database by design: deleting a user
 * cascades to `audit_logs.actor_user_id ON DELETE SET NULL`, which is an UPDATE
 * on an append-only table, and the trigger correctly rejects it.
 *
 * Rather than weaken that trigger — spec §7.2 forbids it, and the guarantee is
 * the product — the suite targets the throwaway Postgres from
 * docker-compose.local.yml and resets with TRUNCATE, which bypasses row-level
 * triggers. Confining TRUNCATE here keeps the immutability guarantee intact
 * everywhere that matters.
 *
 *   pnpm local:db:up && pnpm --filter @gridflex/db exec drizzle-kit migrate
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://gridflex:gridflex@localhost:5433/gridflex';

if (/192\.168\.|coolify|xgpmainz/i.test(TEST_DATABASE_URL)) {
  throw new Error(
    'Refusing to run destructive API tests against a non-disposable database. ' +
      'Set TEST_DATABASE_URL to the local docker-compose Postgres.',
  );
}
process.env.DATABASE_URL = TEST_DATABASE_URL;

const RESETTABLE_TABLES = [
  'auth_refresh_tokens',
  'organization_members',
  'audit_logs',
  'drill_events',
  'drills',
  'app_users',
  'organizations',
];

let app: NestFastifyApplication;
let admin: pg.Client;

/** Unique per run so tests never collide with seeded or prior data. */
const suffix = Date.now().toString(36);
const OWNER_EMAIL = `owner-${suffix}@test.local`;
const PASSWORD = 'correct-horse-battery-staple';

async function post(url: string, payload: unknown, token?: string) {
  return app.inject({
    method: 'POST',
    url,
    payload: payload as object,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function get(url: string, token?: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();

  // Confirm we really are on a disposable database before truncating anything.
  const target = await admin.query<{ db: string; port: string }>(
    `select current_database() as db, inet_server_port()::text as port`,
  );
  if (target.rows[0]?.db !== 'gridflex') {
    throw new Error(`Unexpected test database: ${target.rows[0]?.db}`);
  }

  await admin.query(`truncate ${RESETTABLE_TABLES.join(', ')} restart identity cascade`);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ErrorFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('bootstrap-owner (spec 8.2)', () => {
  it('reports bootstrap as available when no user exists', async () => {
    const response = await get('/api/v1/auth/bootstrap-status');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ bootstrap_available: true });
  });

  it('creates the first owner', async () => {
    const response = await post('/api/v1/auth/bootstrap-owner', {
      email: OWNER_EMAIL,
      display_name: 'Test Owner',
      password: PASSWORD,
      organization_name: 'Test Org',
      organization_slug: `test-org-${suffix}`,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toHaveProperty('user_id');
  });

  it('stores the password as an Argon2id hash, never plaintext', async () => {
    const result = await admin.query<{ password_hash: string }>(
      'select password_hash from app_users where email = $1',
      [OWNER_EMAIL],
    );
    const hash = result.rows[0]!.password_hash;
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain(PASSWORD);
  });

  it('is permanently disabled once an account exists', async () => {
    const response = await post('/api/v1/auth/bootstrap-owner', {
      email: `second-${suffix}@test.local`,
      display_name: 'Second',
      password: PASSWORD,
      organization_name: 'Second Org',
      organization_slug: `second-org-${suffix}`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('BOOTSTRAP_ALREADY_COMPLETED');
  });

  it('rejects a password shorter than 12 characters', async () => {
    const response = await post('/api/v1/auth/bootstrap-owner', {
      email: 'x@test.local',
      display_name: 'X',
      password: 'short',
      organization_name: 'X',
      organization_slug: 'x',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('login', () => {
  it('issues a token pair for correct credentials', async () => {
    const response = await post('/api/v1/auth/login', {
      email: OWNER_EMAIL,
      password: PASSWORD,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(900);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });

  it('returns an identical error for a wrong password and an unknown email', async () => {
    // Divergent responses would let an attacker enumerate registered accounts.
    const wrongPassword = await post('/api/v1/auth/login', {
      email: OWNER_EMAIL,
      password: 'definitely-the-wrong-password',
    });
    const unknownEmail = await post('/api/v1/auth/login', {
      email: `ghost-${suffix}@test.local`,
      password: 'definitely-the-wrong-password',
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json().error.code).toBe(unknownEmail.json().error.code);
    expect(wrongPassword.json().error.message).toBe(unknownEmail.json().error.message);
  });

  it('never returns the password hash', async () => {
    const response = await post('/api/v1/auth/login', {
      email: OWNER_EMAIL,
      password: PASSWORD,
    });
    expect(response.body).not.toContain('argon2');
    expect(response.body).not.toContain(PASSWORD);
  });
});

describe('route protection', () => {
  it('rejects an unauthenticated request with a stable code', async () => {
    const response = await get('/api/v1/auth/me');
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
    expect(response.json()).toHaveProperty('error.request_id');
  });

  it('rejects a forged token', async () => {
    const response = await get('/api/v1/auth/me', 'not.a.real.token');
    expect(response.statusCode).toBe(401);
  });

  it('returns the current user with a valid token', async () => {
    const login = await post('/api/v1/auth/login', { email: OWNER_EMAIL, password: PASSWORD });
    const response = await get('/api/v1/auth/me', login.json().access_token);
    expect(response.statusCode).toBe(200);
    expect(response.json().email).toBe(OWNER_EMAIL);
    expect(response.json().memberships[0].role).toBe('OWNER');
  });

  it('never exposes a stack trace or SQL in an error response', async () => {
    const response = await get('/api/v1/auth/me');
    expect(response.body).not.toMatch(/at .*\(.*:\d+:\d+\)/);
    expect(response.body).not.toMatch(/select |insert |postgres/i);
  });
});

describe('refresh token rotation and reuse detection (spec 8.2)', () => {
  it('rotates the token on every use', async () => {
    const login = await post('/api/v1/auth/login', { email: OWNER_EMAIL, password: PASSWORD });
    const first = login.json().refresh_token;

    const rotated = await post('/api/v1/auth/refresh', { refresh_token: first });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().refresh_token).not.toBe(first);
  });

  it('stores only the SHA-256 hash, never the token itself', async () => {
    const login = await post('/api/v1/auth/login', { email: OWNER_EMAIL, password: PASSWORD });
    const token = login.json().refresh_token;

    const stored = await admin.query<{ token_hash: string }>(
      'select token_hash from auth_refresh_tokens order by created_at desc limit 1',
    );
    expect(stored.rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]!.token_hash).not.toBe(token);
  });

  it('REGRESSION: replaying a rotated token revokes the ENTIRE family', async () => {
    // This previously failed: the family revocation ran inside the rotation
    // transaction, so the throw rolled it back and the newer token stayed live —
    // meaning a captured token remained usable after detection. The revocation
    // must be committed independently of the rejection.
    const login = await post('/api/v1/auth/login', { email: OWNER_EMAIL, password: PASSWORD });
    const r1 = login.json().refresh_token;

    const rotated = await post('/api/v1/auth/refresh', { refresh_token: r1 });
    const r2 = rotated.json().refresh_token;

    // Replay the consumed token.
    const replay = await post('/api/v1/auth/refresh', { refresh_token: r1 });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('TOKEN_REUSE_DETECTED');

    // The still-current token must ALSO be dead now.
    const afterDetection = await post('/api/v1/auth/refresh', { refresh_token: r2 });
    expect(afterDetection.statusCode).toBe(401);
    expect(afterDetection.json().error.code).toBe('TOKEN_REUSE_DETECTED');
  });

  it('records reuse in the audit log, and the record survives', async () => {
    const login = await post('/api/v1/auth/login', { email: OWNER_EMAIL, password: PASSWORD });
    const r1 = login.json().refresh_token;
    await post('/api/v1/auth/refresh', { refresh_token: r1 });
    await post('/api/v1/auth/refresh', { refresh_token: r1 });

    const audit = await admin.query<{ n: number }>(
      `select count(*)::int n from audit_logs where action = 'AUTH_REFRESH_REUSE_DETECTED'`,
    );
    expect(audit.rows[0]!.n).toBeGreaterThan(0);
  });

  it('rejects an unknown refresh token', async () => {
    const response = await post('/api/v1/auth/refresh', { refresh_token: 'nonexistent-token' });
    expect(response.statusCode).toBe(401);
  });
});

describe('password change', () => {
  it('rejects a wrong current password', async () => {
    const login = await post('/api/v1/auth/login', { email: OWNER_EMAIL, password: PASSWORD });
    const response = await post(
      '/api/v1/auth/change-password',
      { current_password: 'wrong', new_password: 'a-brand-new-password' },
      login.json().access_token,
    );
    expect(response.statusCode).toBe(401);
  });

  it('changes the password and revokes every existing session', async () => {
    const login = await post('/api/v1/auth/login', { email: OWNER_EMAIL, password: PASSWORD });
    const refreshToken = login.json().refresh_token;
    const newPassword = 'a-brand-new-long-password';

    const changed = await post(
      '/api/v1/auth/change-password',
      { current_password: PASSWORD, new_password: newPassword },
      login.json().access_token,
    );
    expect(changed.statusCode).toBe(204);

    // Old sessions must not survive a password change.
    const stale = await post('/api/v1/auth/refresh', { refresh_token: refreshToken });
    expect(stale.statusCode).toBe(401);

    // The new password works.
    const relogin = await post('/api/v1/auth/login', {
      email: OWNER_EMAIL,
      password: newPassword,
    });
    expect(relogin.statusCode).toBe(200);
  });
});

describe('health (spec 6.2)', () => {
  it('reports each dependency separately', async () => {
    const response = await get('/api/v1/health/ready');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('database');
    expect(body).toHaveProperty('schema_revision');
    expect(body).toHaveProperty('worker_last_seen');
    expect(body).toHaveProperty('storage');
    expect(body.database).toBe('reachable');
  });

  it('never exposes hostnames or credentials', async () => {
    const response = await get('/api/v1/health/ready');
    expect(response.body).not.toMatch(/postgres(ql)?:\/\//);
    expect(response.body).not.toContain('192.168');
    expect(response.body).not.toContain('password');
  });
});
