import { z } from 'zod';
import {
  powerKwSchema,
  provenanceSchema,
  ratioSchema,
  utcTimestampSchema,
  uuidSchema,
} from './primitives.js';

export const envelopeStatusSchema = z.enum([
  'DRAFT',
  'CURRENT',
  'STALE',
  'SUPERSEDED',
  'BLOCKED',
]);

/** Every envelope field carries provenance (spec §12). */
export const envelopeMechanismSchema = z.object({
  mechanism_id: uuidSchema,
  mechanism_code: z.string(),
  mechanism_name: z.string(),
  provenance: provenanceSchema,
  reducible_kw: powerKwSchema,
  response_time_seconds: z.number().int().min(0),
  ramp_kw_per_min: powerKwSchema,
  duration_min: z.number().int().min(0),
  rebound_peak_kw: powerKwSchema.nullable(),
  rebound_duration_min: z.number().int().min(0).nullable(),
  confidence_score: ratioSchema,
  evidence_refs: z.array(z.string()),
  notes: z.string().nullable(),
});

export const envelopeSchema = z.object({
  id: uuidSchema,
  facility_id: uuidSchema,
  version: z.number().int().positive(),
  status: envelopeStatusSchema,
  as_of: utcTimestampSchema,
  valid_until: utcTimestampSchema.nullable(),
  total_reducible_kw: powerKwSchema,
  response_time_seconds: z.number().int().min(0),
  sustainable_duration_min: z.number().int().min(0),
  aggregate_ramp_kw_per_min: powerKwSchema,
  rebound_peak_kw: powerKwSchema.nullable(),
  rebound_duration_min: z.number().int().min(0).nullable(),
  confidence_score: ratioSchema,
  telemetry_completeness: ratioSchema,
  methodology_version: z.string(),
  constraints_version: z.number().int().positive(),
  blocked_reasons: z.array(z.object({ code: z.string(), detail: z.string() })),
  mechanisms: z.array(envelopeMechanismSchema),
  created_at: utcTimestampSchema,
});

/**
 * The explanation endpoint (spec §9.3) exposes the reasoning, not just the
 * result. Every cap that bound the outcome is named, so a reviewer can see why a
 * number is what it is rather than trusting it.
 */
export const envelopeExplanationSchema = z.object({
  envelope_id: uuidSchema,
  engine_run_id: uuidSchema,
  methodology_version: z.string(),
  modeling_window: z.object({
    start: utcTimestampSchema,
    end: utcTimestampSchema,
    completeness: ratioSchema,
  }),
  binding_constraint: z.string(),
  decisions: z.array(
    z.object({
      decision_type: z.string(),
      decision_code: z.string(),
      severity: z.enum(['INFO', 'WARNING', 'BLOCKER']),
      facts: z.record(z.unknown()),
      rules_evaluated: z.array(z.string()),
    }),
  ),
  confidence_adjustments: z.array(
    z.object({ code: z.string(), delta: z.number(), reason: z.string() }),
  ),
});

export type Envelope = z.infer<typeof envelopeSchema>;
export type EnvelopeMechanism = z.infer<typeof envelopeMechanismSchema>;
export type EnvelopeExplanation = z.infer<typeof envelopeExplanationSchema>;
