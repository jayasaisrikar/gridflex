import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  bootstrapOwnerRequestSchema,
  createDrillRequestSchema,
  decimalStringSchema,
  errorEnvelopeSchema,
  passwordSchema,
  powerKwSchema,
  roleHasPermission,
  telemetryBatchRequestSchema,
  utcTimestampSchema,
  type UserRole,
} from '../src/index.js';

describe('utcTimestampSchema', () => {
  it('accepts RFC 3339 UTC instants', () => {
    expect(utcTimestampSchema.safeParse('2026-07-21T12:00:00Z').success).toBe(true);
    expect(utcTimestampSchema.safeParse('2026-07-21T12:00:00.250Z').success).toBe(true);
  });

  it('rejects offsets so everything stored and hashed is unambiguously UTC', () => {
    expect(utcTimestampSchema.safeParse('2026-07-21T14:00:00+02:00').success).toBe(false);
    expect(utcTimestampSchema.safeParse('2026-07-21 12:00:00').success).toBe(false);
    expect(utcTimestampSchema.safeParse('not-a-time').success).toBe(false);
  });
});

describe('decimal handling (spec 4.1)', () => {
  it('accepts decimals as strings', () => {
    expect(decimalStringSchema.safeParse('1600.250').success).toBe(true);
    expect(decimalStringSchema.safeParse('-25.5').success).toBe(true);
  });

  it('rejects JS numbers, which would lose precision across the boundary', () => {
    expect(decimalStringSchema.safeParse(1600.25).success).toBe(false);
  });

  it('rejects power beyond numeric(14,3) precision', () => {
    expect(powerKwSchema.safeParse('1600.250').success).toBe(true);
    expect(powerKwSchema.safeParse('1600.2501').success).toBe(false);
  });

  it('rejects negative power', () => {
    expect(powerKwSchema.safeParse('-10').success).toBe(false);
  });
});

describe('password policy (spec 8.2)', () => {
  it('requires at least 12 characters', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(11)).success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(12)).success).toBe(true);
  });
});

describe('bootstrapOwnerRequestSchema', () => {
  const valid = {
    email: 'Owner@Example.COM',
    display_name: 'Owner',
    password: 'correct-horse-battery',
    organization_name: 'GridFlex Demo',
    organization_slug: 'gridflex-demo',
  };

  it('normalizes email to lowercase to match the citext column', () => {
    const parsed = bootstrapOwnerRequestSchema.parse(valid);
    expect(parsed.email).toBe('owner@example.com');
  });

  it('rejects a malformed slug', () => {
    expect(
      bootstrapOwnerRequestSchema.safeParse({ ...valid, organization_slug: 'Not A Slug' }).success,
    ).toBe(false);
  });
});

describe('telemetry batch (spec 9.2, 10.1)', () => {
  const reading = {
    metric_key: 'facility.active_power_kw',
    measured_at: '2026-07-21T12:00:00Z',
    value: '1600.25',
    unit: 'kW',
    quality: 'GOOD',
  };

  it('accepts a well-formed batch', () => {
    const result = telemetryBatchRequestSchema.safeParse({
      source_key: 'simulator-main-meter',
      readings: [reading],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a unit that disagrees with the canonical metric', () => {
    // Silently coercing MW to kW would corrupt every downstream calculation.
    const result = telemetryBatchRequestSchema.safeParse({
      source_key: 'meter',
      readings: [{ ...reading, unit: 'MW' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown metric key', () => {
    const result = telemetryBatchRequestSchema.safeParse({
      source_key: 'meter',
      readings: [{ ...reading, metric_key: 'facility.made_up_metric' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty batch and one exceeding the row cap', () => {
    expect(telemetryBatchRequestSchema.safeParse({ source_key: 'm', readings: [] }).success).toBe(false);
    expect(
      telemetryBatchRequestSchema.safeParse({
        source_key: 'm',
        readings: Array.from({ length: 10_001 }, () => reading),
      }).success,
    ).toBe(false);
  });
});

describe('createDrillRequestSchema', () => {
  const valid = {
    name: 'Canonical drill',
    requested_reduction_kw: '500',
    planned_start_at: '2026-07-21T12:00:00Z',
    planned_end_at: '2026-07-21T12:30:00Z',
  };

  it('accepts a valid plan and defaults to simulation mode', () => {
    const parsed = createDrillRequestSchema.parse(valid);
    // V1 ships no unsupervised production control (spec 2.2).
    expect(parsed.simulation_mode).toBe(true);
  });

  it('rejects an end time at or before the start', () => {
    expect(
      createDrillRequestSchema.safeParse({ ...valid, planned_end_at: valid.planned_start_at })
        .success,
    ).toBe(false);
  });
});

describe('RBAC matrix (spec 8.1)', () => {
  it('grants OWNER every permission', () => {
    for (const permission of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) {
      expect(roleHasPermission('OWNER', permission), permission).toBe(true);
    }
  });

  it('restricts VIEWER to read-only surfaces', () => {
    expect(roleHasPermission('VIEWER', 'passport:read')).toBe(true);
    expect(roleHasPermission('VIEWER', 'drill:read')).toBe(true);
    expect(roleHasPermission('VIEWER', 'drill:arm')).toBe(false);
    expect(roleHasPermission('VIEWER', 'passport:issue')).toBe(false);
    expect(roleHasPermission('VIEWER', 'telemetry:write')).toBe(false);
  });

  it('does not let REVIEWER arm drills or trigger emergency stop', () => {
    expect(roleHasPermission('REVIEWER', 'drill:arm')).toBe(false);
    expect(roleHasPermission('REVIEWER', 'drill:emergency_stop')).toBe(false);
    expect(roleHasPermission('REVIEWER', 'export:create')).toBe(true);
  });

  it('lets OPS_ENGINEER arm and emergency-stop but not issue passports', () => {
    expect(roleHasPermission('OPS_ENGINEER', 'drill:arm')).toBe(true);
    expect(roleHasPermission('OPS_ENGINEER', 'drill:emergency_stop')).toBe(true);
    expect(roleHasPermission('OPS_ENGINEER', 'passport:issue')).toBe(false);
  });

  it('reserves member management for OWNER alone', () => {
    const others: UserRole[] = ['FACILITY_ADMIN', 'OPS_ENGINEER', 'REVIEWER', 'VIEWER'];
    for (const role of others) {
      expect(roleHasPermission(role, 'member:manage'), role).toBe(false);
    }
  });

  it('gives every role emergency-stop access only if it can also arm', () => {
    // A role that can start a drill must be able to stop one.
    const roles: UserRole[] = ['OWNER', 'FACILITY_ADMIN', 'OPS_ENGINEER', 'REVIEWER', 'VIEWER'];
    for (const role of roles) {
      if (roleHasPermission(role, 'drill:arm')) {
        expect(roleHasPermission(role, 'drill:emergency_stop'), role).toBe(true);
      }
    }
  });
});

describe('error envelope (spec 9)', () => {
  it('accepts a well-formed envelope', () => {
    expect(
      errorEnvelopeSchema.safeParse({
        error: {
          code: 'TELEMETRY_STALE',
          message: 'A current drill cannot be armed because telemetry is stale.',
          details: { last_reading_at: '2026-07-21T11:00:00Z' },
          request_id: 'req-123',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown error code, keeping codes a closed contract', () => {
    expect(
      errorEnvelopeSchema.safeParse({
        error: { code: 'SOMETHING_ELSE', message: 'x', request_id: 'r' },
      }).success,
    ).toBe(false);
  });
});
