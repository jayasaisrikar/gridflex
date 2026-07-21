import { z } from 'zod';
import {
  basisPointsSchema,
  powerKwSchema,
  ratioSchema,
  utcTimestampSchema,
  uuidSchema,
} from './primitives.js';

export const drillStatusSchema = z.enum([
  'DRAFT',
  'READY',
  'ARMED',
  'RUNNING',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'ABORTED',
  'CANCELLED',
]);

export const drillEventTypeSchema = z.enum([
  'CREATED',
  'VALIDATED',
  'ARMED',
  'STARTED',
  'SETPOINT_CHANGED',
  'TELEMETRY_WARNING',
  'EMERGENCY_STOP',
  'COMPLETED',
  'FAILED',
  'ABORTED',
  'MRV_GENERATED',
  'PASSPORT_ISSUED',
]);

export type DrillStatus = z.infer<typeof drillStatusSchema>;
export type DrillEventType = z.infer<typeof drillEventTypeSchema>;

export const createDrillRequestSchema = z
  .object({
    name: z.string().min(1).max(200),
    requested_reduction_kw: powerKwSchema,
    planned_start_at: utcTimestampSchema,
    planned_end_at: utcTimestampSchema,
    envelope_id: uuidSchema.optional(),
    operator_notes: z.string().max(2000).optional(),
    /** V1 ships simulated drills only; real dispatch is out of scope (spec §2.2). */
    simulation_mode: z.boolean().default(true),
  })
  .refine(
    (drill) => Date.parse(drill.planned_end_at) > Date.parse(drill.planned_start_at),
    { message: 'planned_end_at must be after planned_start_at', path: ['planned_end_at'] },
  );

/**
 * Two-step arming (spec §9.4).
 *
 * `arm-intent` returns the exact constraints and expected effects the operator is
 * agreeing to, plus a short-lived single-use challenge. `arm-confirm` requires
 * that challenge ID and a typed confirmation phrase. The operator must be shown
 * what they are approving, not just a yes/no prompt.
 */
export const ARM_CHALLENGE_TTL_SECONDS = 300;

export const armIntentResponseSchema = z.object({
  challenge_id: uuidSchema,
  expires_at: utcTimestampSchema,
  /** The literal phrase the operator must type back, verbatim. */
  confirmation_phrase: z.string().min(1),
  constraint_snapshot: z.object({
    minimum_safe_load_kw: powerKwSchema,
    maximum_curtailment_kw: powerKwSchema,
    maximum_ramp_kw_per_min: powerKwSchema,
    maximum_duration_min: z.number().int().positive(),
    thermal_limit_c: z.string().nullable(),
  }),
  expected_effects: z.object({
    target_load_kw: powerKwSchema,
    reduction_kw: powerKwSchema,
    duration_min: z.number().int().positive(),
    estimated_energy_kwh: z.string(),
    ramp_duration_min: z.string(),
  }),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});

export const armConfirmRequestSchema = z.object({
  challenge_id: uuidSchema,
  confirmation_phrase: z.string().min(1),
});

export const abortDrillRequestSchema = z.object({
  reason_code: z.string().min(1).max(64),
  reason_detail: z.string().max(2000).optional(),
});

export const emergencyStopRequestSchema = z.object({
  reason_code: z.string().min(1).max(64),
  reason_detail: z.string().max(2000).optional(),
});

export const drillEventSchema = z.object({
  id: z.string(),
  event_type: drillEventTypeSchema,
  occurred_at: utcTimestampSchema,
  actor_user_id: uuidSchema.nullable(),
  actor_service: z.string().nullable(),
  reason_code: z.string().nullable(),
  payload: z.record(z.unknown()),
  correlation_id: uuidSchema,
});

export const mrvReportSchema = z.object({
  id: uuidSchema,
  drill_id: uuidSchema,
  methodology_version: z.string(),
  interval_seconds: z.number().int().positive(),
  /** Energy as decimal strings — these are certified values (spec §4.1). */
  committed_energy_wh: z.string(),
  delivered_energy_wh: z.string(),
  average_delivered_kw: powerKwSchema,
  performance_bps: basisPointsSchema,
  telemetry_completeness: ratioSchema,
  maximum_gap_intervals: z.number().int().min(0),
  rebound_energy_wh: z.string().nullable(),
  baseline_series: z.array(z.object({ measured_at: utcTimestampSchema, value: z.string() })),
  actual_series: z.array(
    z.object({ measured_at: utcTimestampSchema, value: z.string().nullable() }),
  ),
  quality_blocks: z.array(
    z.object({ code: z.string(), interval_index: z.number().int(), detail: z.string() }),
  ),
  generated_at: utcTimestampSchema,
});

export type CreateDrillRequest = z.infer<typeof createDrillRequestSchema>;
export type ArmIntentResponse = z.infer<typeof armIntentResponseSchema>;
export type MrvReport = z.infer<typeof mrvReportSchema>;
