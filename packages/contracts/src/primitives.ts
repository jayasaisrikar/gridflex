import { z } from 'zod';

/**
 * Shared primitives for every request and response schema.
 *
 * Spec §9: UUID strings, RFC 3339 UTC timestamps, and decimal STRINGS for
 * precision-sensitive energy values. The web app and API import these same
 * schemas, so a drift between client and server is a type error, not a bug
 * discovered in production.
 */

export const uuidSchema = z.string().uuid();

/**
 * RFC 3339 UTC instant. Deliberately strict: an offset like `+02:00` is rejected
 * at the API boundary so that everything stored and hashed is unambiguously UTC
 * (spec §4.1 "Use UTC internally"). Callers convert before sending.
 */
export const utcTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
    'Must be an RFC 3339 UTC timestamp ending in Z',
  )
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Must be a valid instant');

/**
 * A precision-sensitive decimal carried as a string (spec §4.1, §9). Never a
 * JS number — 1600.25 kW must survive the round trip exactly.
 */
export const decimalStringSchema = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?$/, 'Must be a decimal number represented as a string');

/** A non-negative decimal string, for quantities where negative is meaningless. */
export const nonNegativeDecimalSchema = decimalStringSchema.refine(
  (value) => !value.startsWith('-'),
  'Must not be negative',
);

/** Power in kW, at most 3 decimal places to match numeric(14,3). */
export const powerKwSchema = nonNegativeDecimalSchema.refine(
  (value) => (value.split('.')[1]?.length ?? 0) <= 3,
  'Power supports at most 3 decimal places',
);

/** A ratio in [0,1], used for confidence and completeness. */
export const ratioSchema = z.number().min(0).max(1);

/** Basis points in [0,10000] (spec §14). */
export const basisPointsSchema = z.number().int().min(0).max(10_000);

export const provenanceSchema = z.enum(['DECLARED', 'MODELED', 'TESTED']);
export const userRoleSchema = z.enum([
  'OWNER',
  'FACILITY_ADMIN',
  'OPS_ENGINEER',
  'REVIEWER',
  'VIEWER',
]);

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export type Provenance = z.infer<typeof provenanceSchema>;
export type UserRole = z.infer<typeof userRoleSchema>;
