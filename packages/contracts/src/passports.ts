import { z } from 'zod';
import { utcTimestampSchema, uuidSchema } from './primitives.js';
import { envelopeSchema } from './envelopes.js';

export const passportStatusSchema = z.enum(['DRAFT', 'ISSUED', 'SUPERSEDED', 'REVOKED']);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Must be a lowercase hex SHA-256 digest');

/**
 * The Passport is the product (spec §15.2). Once issued it is NEVER edited —
 * a later version supersedes it, and revocation preserves the original and adds
 * a reason. Every claim in here must be traceable to telemetry, constraints,
 * deterministic calculation, a methodology version, and immutable evidence.
 */
export const passportSchema = z.object({
  id: uuidSchema,
  facility_id: uuidSchema,
  version: z.number().int().positive(),
  status: passportStatusSchema,
  passport_sha256: sha256Schema,
  evidence_bundle_id: uuidSchema,
  evidence_sha256: sha256Schema,
  issued_at: utcTimestampSchema.nullable(),
  superseded_by: uuidSchema.nullable(),
  revocation_reason: z.string().nullable(),

  facility: z.object({
    name: z.string(),
    timezone: z.string(),
    region: z.string().nullable(),
    market: z.string().nullable(),
  }),
  methodology_version: z.string(),
  envelope: envelopeSchema,

  safety: z.object({
    minimum_safe_load_kw: z.string(),
    maximum_curtailment_kw: z.string(),
    maximum_ramp_kw_per_min: z.string(),
    maximum_duration_min: z.number().int(),
    excluded_workloads: z.array(z.string()),
    constraints_version: z.number().int(),
  }),

  data_quality: z.object({
    completeness: z.number().min(0).max(1),
    window_start: utcTimestampSchema,
    window_end: utcTimestampSchema,
    connector_provenance: z.array(
      z.object({
        connector_type: z.string(),
        name: z.string(),
        last_success_at: utcTimestampSchema.nullable(),
      }),
    ),
    /**
     * Simulated data must be unmistakably labelled wherever it appears
     * (spec §3, §11, §24). This flag is part of the hashed document.
     */
    contains_simulated_data: z.boolean(),
  }),

  drill_history: z.array(
    z.object({
      drill_id: uuidSchema,
      name: z.string(),
      status: z.string(),
      started_at: utcTimestampSchema.nullable(),
      requested_reduction_kw: z.string(),
      delivered_energy_wh: z.string().nullable(),
      performance_bps: z.number().int().nullable(),
      simulation_mode: z.boolean(),
    }),
  ),

  /** Plain-language limitations, required on every Passport (spec §15.2). */
  limitations: z.array(z.string()).min(1),
});

export const issuePassportRequestSchema = z.object({
  envelope_id: uuidSchema.optional(),
  drill_id: uuidSchema.optional(),
  notes: z.string().max(2000).optional(),
});

/**
 * Independent verification (spec §9.5, §24). A reviewer recomputes the hash from
 * the canonical JSON and compares — this endpoint reports that comparison.
 */
export const passportVerificationSchema = z.object({
  passport_id: uuidSchema,
  version: z.number().int().positive(),
  status: passportStatusSchema,
  stored_passport_sha256: sha256Schema,
  recomputed_passport_sha256: sha256Schema,
  passport_hash_matches: z.boolean(),
  stored_evidence_sha256: sha256Schema,
  recomputed_evidence_sha256: sha256Schema,
  evidence_hash_matches: z.boolean(),
  verified_at: utcTimestampSchema,
  canonicalization_schema_version: z.string(),
  instructions: z.string(),
});

export type Passport = z.infer<typeof passportSchema>;
export type PassportVerification = z.infer<typeof passportVerificationSchema>;
