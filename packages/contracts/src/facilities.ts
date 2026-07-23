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

const facilityWriteFields = {
  name: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens'),
  /** IANA zone, kept for presentation and schedule interpretation only (spec §4.1). */
  timezone: z.string().trim().min(1).max(64),
  country_code: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  region: z.string().trim().min(1).max(100),
  market: z.string().trim().min(1).max(100),
  normal_load_kw: powerKwSchema,
  minimum_safe_load_kw: powerKwSchema,
  maximum_curtailment_kw: powerKwSchema,
  ramp_rate_kw_per_min: powerKwSchema,
  cooling_reserve_kw: powerKwSchema,
};

function facilityLimitsAreConsistent(value: {
  normal_load_kw?: string | undefined;
  minimum_safe_load_kw?: string | undefined;
  maximum_curtailment_kw?: string | undefined;
}): boolean {
  if (value.normal_load_kw && value.minimum_safe_load_kw) {
    if (Number(value.minimum_safe_load_kw) > Number(value.normal_load_kw)) return false;
  }
  if (value.normal_load_kw && value.maximum_curtailment_kw) {
    if (Number(value.maximum_curtailment_kw) > Number(value.normal_load_kw)) return false;
  }
  return true;
}

export const createFacilityRequestSchema = z
  .object({
    /** Optional only for the single-membership MVP bootstrap flow. */
    organization_id: uuidSchema.optional(),
    ...facilityWriteFields,
    timezone: facilityWriteFields.timezone.default('UTC'),
    country_code: facilityWriteFields.country_code.optional(),
    region: facilityWriteFields.region.optional(),
    market: facilityWriteFields.market.optional(),
    normal_load_kw: facilityWriteFields.normal_load_kw.optional(),
    minimum_safe_load_kw: facilityWriteFields.minimum_safe_load_kw.optional(),
    maximum_curtailment_kw: facilityWriteFields.maximum_curtailment_kw.optional(),
    ramp_rate_kw_per_min: facilityWriteFields.ramp_rate_kw_per_min.optional(),
    cooling_reserve_kw: facilityWriteFields.cooling_reserve_kw.optional(),
  })
  .refine(facilityLimitsAreConsistent, {
    message: 'Facility safety limits must not exceed normal load',
    path: ['minimum_safe_load_kw'],
  });

export const updateFacilityRequestSchema = z
  .object({
    ...facilityWriteFields,
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be supplied')
  .refine(facilityLimitsAreConsistent, {
    message: 'Facility safety limits must not exceed normal load',
    path: ['minimum_safe_load_kw'],
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

export const updateMechanismRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable(),
    mechanism_type: z.enum(['WORKLOAD', 'COOLING', 'STORAGE', 'OTHER']),
    enabled: z.boolean(),
    declared_reducible_kw: powerKwSchema.nullable(),
    minimum_load_kw: powerKwSchema.nullable(),
    ramp_rate_kw_per_min: powerKwSchema.nullable(),
    maximum_duration_min: z.number().int().positive().nullable(),
    rebound_window_min: z.number().int().min(0).nullable(),
    control_reference: z.string().trim().max(200).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be supplied');

export type Facility = z.infer<typeof facilitySchema>;
export type CreateFacilityRequest = z.infer<typeof createFacilityRequestSchema>;
export type UpdateFacilityRequest = z.infer<typeof updateFacilityRequestSchema>;
export type CreateConstraintsRequest = z.infer<typeof createConstraintsRequestSchema>;
export type FlexibilityMechanism = z.infer<typeof flexibilityMechanismSchema>;
export type CreateMechanismRequest = z.infer<typeof createMechanismRequestSchema>;
export type UpdateMechanismRequest = z.infer<typeof updateMechanismRequestSchema>;
