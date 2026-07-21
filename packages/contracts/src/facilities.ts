import { z } from 'zod';
import { powerKwSchema, utcTimestampSchema, uuidSchema } from './primitives.js';

export const facilitySchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  country_code: z.string().length(2).nullable(),
  region: z.string().nullable(),
  market: z.string().nullable(),
  normal_load_kw: powerKwSchema.nullable(),
  minimum_safe_load_kw: powerKwSchema.nullable(),
  maximum_curtailment_kw: powerKwSchema.nullable(),
  ramp_rate_kw_per_min: powerKwSchema.nullable(),
  cooling_reserve_kw: powerKwSchema.nullable(),
  status: z.string(),
  created_at: utcTimestampSchema,
});

export const createFacilityRequestSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens'),
  /** IANA zone, kept for presentation and schedule interpretation only (spec §4.1). */
  timezone: z.string().min(1).max(64).default('UTC'),
  country_code: z.string().length(2).optional(),
  region: z.string().max(100).optional(),
  market: z.string().max(100).optional(),
  normal_load_kw: powerKwSchema.optional(),
  minimum_safe_load_kw: powerKwSchema.optional(),
  maximum_curtailment_kw: powerKwSchema.optional(),
  ramp_rate_kw_per_min: powerKwSchema.optional(),
  cooling_reserve_kw: powerKwSchema.optional(),
});

/**
 * Safety constraints are versioned and never edited in place — a change creates
 * a new version so that any envelope or drill can be traced to the exact limits
 * in force at the time (spec §7.2 corrections-as-new-rows).
 */
export const createConstraintsRequestSchema = z
  .object({
    minimum_safe_load_kw: powerKwSchema,
    maximum_curtailment_kw: powerKwSchema,
    maximum_ramp_kw_per_min: powerKwSchema,
    maximum_duration_min: z.number().int().positive(),
    minimum_recovery_min: z.number().int().min(0).default(0),
    maximum_rebound_kw: powerKwSchema.optional(),
    thermal_limit_c: z.string().optional(),
    excluded_workloads: z.array(z.string()).default([]),
    tenant_carve_outs: z.array(z.string()).default([]),
    source_note: z.string().max(2000).optional(),
  })
  .refine(
    (constraints) =>
      Number(constraints.maximum_ramp_kw_per_min) > 0,
    { message: 'maximum_ramp_kw_per_min must be greater than zero', path: ['maximum_ramp_kw_per_min'] },
  );

export const flexibilityMechanismSchema = z.object({
  id: uuidSchema,
  facility_id: uuidSchema,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  mechanism_type: z.string(),
  enabled: z.boolean(),
  declared_reducible_kw: powerKwSchema.nullable(),
  minimum_load_kw: powerKwSchema.nullable(),
  ramp_rate_kw_per_min: powerKwSchema.nullable(),
  maximum_duration_min: z.number().int().positive().nullable(),
  rebound_window_min: z.number().int().min(0).nullable(),
  control_reference: z.string().nullable(),
});

export const createMechanismRequestSchema = z.object({
  code: z.string().min(1).max(64).regex(/^[A-Z0-9_]+$/, 'Code must be UPPER_SNAKE_CASE'),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  mechanism_type: z.enum(['WORKLOAD', 'COOLING', 'STORAGE', 'OTHER']),
  enabled: z.boolean().default(true),
  declared_reducible_kw: powerKwSchema.optional(),
  minimum_load_kw: powerKwSchema.optional(),
  ramp_rate_kw_per_min: powerKwSchema.optional(),
  maximum_duration_min: z.number().int().positive().optional(),
  rebound_window_min: z.number().int().min(0).optional(),
  control_reference: z.string().max(200).optional(),
});

export type Facility = z.infer<typeof facilitySchema>;
export type CreateFacilityRequest = z.infer<typeof createFacilityRequestSchema>;
export type FlexibilityMechanism = z.infer<typeof flexibilityMechanismSchema>;
