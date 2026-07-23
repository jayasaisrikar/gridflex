import { describe, expect, it } from 'vitest';
import {
  armConfirmRequestSchema,
  createDrillRequestSchema,
  createPassportExportRequestSchema,
} from '../src/index.js';

describe('pilot drill and evidence request contracts', () => {
  it('accepts an explicit planned ramp while retaining simulation as the default', () => {
    const parsed = createDrillRequestSchema.parse({
      name: 'Operator-approved drill',
      requested_reduction_kw: '500.000',
      planned_ramp_kw_per_min: '100.000',
      planned_start_at: '2026-07-23T12:00:00Z',
      planned_end_at: '2026-07-23T12:30:00Z',
    });
    expect(parsed.planned_ramp_kw_per_min).toBe('100.000');
    expect(parsed.simulation_mode).toBe(true);
  });

  it('rejects zero reduction, zero ramp, and any non-simulated V1 drill', () => {
    const base = {
      name: 'Unsafe no-op',
      requested_reduction_kw: '500.000',
      planned_ramp_kw_per_min: '100.000',
      planned_start_at: '2026-07-23T12:00:00Z',
      planned_end_at: '2026-07-23T12:30:00Z',
      simulation_mode: true,
    } as const;
    expect(
      createDrillRequestSchema.safeParse({ ...base, requested_reduction_kw: '0' }).success,
    ).toBe(false);
    expect(
      createDrillRequestSchema.safeParse({ ...base, planned_ramp_kw_per_min: '0' }).success,
    ).toBe(false);
    expect(
      createDrillRequestSchema.safeParse({ ...base, simulation_mode: false }).success,
    ).toBe(false);
  });

  it('requires both halves of the two-step arming ceremony', () => {
    expect(
      armConfirmRequestSchema.safeParse({
        challenge_id: '10000000-0000-4000-8000-000000000001',
        confirmation_phrase: 'ARM Pilot drill',
      }).success,
    ).toBe(true);
    expect(
      armConfirmRequestSchema.safeParse({
        challenge_id: '10000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
  });

  it('limits synchronous pilot exports to implemented JSON, CSV, and PDF formats', () => {
    expect(createPassportExportRequestSchema.safeParse({ format: 'JSON' }).success).toBe(true);
    expect(createPassportExportRequestSchema.safeParse({ format: 'CSV' }).success).toBe(true);
    expect(createPassportExportRequestSchema.safeParse({ format: 'PDF' }).success).toBe(true);
    expect(createPassportExportRequestSchema.safeParse({ format: 'XML' }).success).toBe(false);
  });
});
