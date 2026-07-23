import { z } from 'zod';
import {
  decimalStringSchema,
  powerKwSchema,
  provenanceSchema,
  utcTimestampSchema,
  uuidSchema,
} from './primitives.js';

export const passportStatusSchema = z.enum(['DRAFT', 'ISSUED', 'SUPERSEDED', 'REVOKED']);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Must be a lowercase hex SHA-256 digest');

/** Ratios are decimal strings in canonical evidence; floats are not portable. */
const ratioStringSchema = decimalStringSchema.refine(
  (value) => Number(value) >= 0 && Number(value) <= 1,
  'Must be a decimal ratio between 0 and 1',
);

const passportEnvelopeMechanismSchema = z.object({
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
  confidence_score: ratioStringSchema,
  evidence_refs: z.array(z.string()),
  notes: z.string().nullable(),
});

const passportEnvelopeSchema = z.object({
  id: uuidSchema,
  facility_id: uuidSchema,
  version: z.number().int().positive(),
  status: z.literal('CURRENT'),
  as_of: utcTimestampSchema,
  valid_until: utcTimestampSchema.nullable(),
  total_reducible_kw: powerKwSchema,
  response_time_seconds: z.number().int().min(0),
  sustainable_duration_min: z.number().int().min(0),
  aggregate_ramp_kw_per_min: powerKwSchema,
  rebound_peak_kw: powerKwSchema.nullable(),
  rebound_duration_min: z.number().int().min(0).nullable(),
  confidence_score: ratioStringSchema,
  telemetry_completeness: ratioStringSchema,
  methodology_version: z.string(),
  constraints_version: z.number().int().positive(),
  blocked_reasons: z.array(z.object({ code: z.string(), detail: z.string() })),
  mechanisms: z.array(passportEnvelopeMechanismSchema),
  created_at: utcTimestampSchema,
});

/**
 * The Passport is the product (spec §15.2). Once issued it is NEVER edited —
 * a later version supersedes it, and revocation preserves the original and adds
 * a reason. Every claim in here must be traceable to telemetry, constraints,
 * deterministic calculation, a methodology version, and immutable evidence.
 */
export const passportDocumentSchema = z.object({
  id: uuidSchema,
  facility_id: uuidSchema,
  version: z.number().int().positive(),
  evidence_bundle_id: uuidSchema,
  evidence_sha256: sha256Schema,
  issued_at: utcTimestampSchema,

  facility: z.object({
    name: z.string(),
    timezone: z.string(),
    region: z.string().nullable(),
    market: z.string().nullable(),
  }),
  methodology_version: z.string(),
  envelope: passportEnvelopeSchema,

  safety: z.object({
    minimum_safe_load_kw: z.string(),
    maximum_curtailment_kw: z.string(),
    maximum_ramp_kw_per_min: z.string(),
    maximum_duration_min: z.number().int(),
    excluded_workloads: z.array(z.string()),
    constraints_version: z.number().int(),
  }),

  data_quality: z.object({
    completeness: ratioStringSchema,
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
  notes: z.string().nullable(),
});

/**
 * API record. `document` is the immutable object that was hashed at issuance;
 * lifecycle metadata can later say SUPERSEDED/REVOKED without mutating it.
 */
export const passportSchema = z.object({
  status: passportStatusSchema,
  passport_sha256: sha256Schema,
  superseded_by: uuidSchema.nullable(),
  revocation_reason: z.string().nullable(),
  document: passportDocumentSchema,
});

export const issuePassportRequestSchema = z.object({
  envelope_id: uuidSchema.optional(),
  drill_id: uuidSchema.optional(),
  notes: z.string().max(2000).optional(),
});

export const exportFormatSchema = z.enum(['JSON', 'CSV', 'PDF']);

export const createPassportExportRequestSchema = z.object({
  format: exportFormatSchema,
  counterparty_name: z.string().min(1).max(200).optional(),
});

export const passportSummarySchema = z.object({
  id: uuidSchema,
  facility_id: uuidSchema,
  version: z.number().int().positive(),
  status: passportStatusSchema,
  passport_sha256: sha256Schema,
  evidence_sha256: sha256Schema,
  issued_at: utcTimestampSchema.nullable(),
  superseded_by: uuidSchema.nullable(),
  contains_simulated_data: z.boolean(),
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
export type PassportDocument = z.infer<typeof passportDocumentSchema>;
export type PassportVerification = z.infer<typeof passportVerificationSchema>;
export type IssuePassportRequest = z.infer<typeof issuePassportRequestSchema>;
export type CreatePassportExportRequest = z.infer<typeof createPassportExportRequestSchema>;
