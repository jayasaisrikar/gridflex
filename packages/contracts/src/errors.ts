import { z } from 'zod';

/**
 * The single error envelope for every endpoint (spec §9).
 *
 * Codes are STABLE identifiers. Spec §4.1 forbids branching on error-message
 * text, so the code is the contract and the message is for humans only.
 */

export const ERROR_CODES = [
  // Auth
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'TOKEN_EXPIRED',
  'TOKEN_REUSE_DETECTED',
  'FORBIDDEN',
  'BOOTSTRAP_ALREADY_COMPLETED',
  'PASSWORD_TOO_WEAK',

  // Generic
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'IDEMPOTENCY_KEY_REUSED',

  // Telemetry and data quality
  'TELEMETRY_STALE',
  'TELEMETRY_INCOMPLETE',
  'TELEMETRY_DUPLICATE_CONFLICT',
  'TELEMETRY_INVALID_TIMESTAMP',
  'CSV_TOO_LARGE',
  'CSV_MALFORMED',

  // Envelope
  'ENVELOPE_BLOCKED_DATA_QUALITY',
  'ENVELOPE_NOT_CURRENT',
  'NO_ENABLED_MECHANISMS',
  'CONSTRAINTS_MISSING',

  // Drill and safety
  'DRILL_INVALID_TRANSITION',
  'DRILL_ALREADY_LIVE',
  'DRILL_EXCEEDS_ENVELOPE',
  'DRILL_BELOW_MINIMUM_SAFE_LOAD',
  'DRILL_EXCEEDS_RAMP_LIMIT',
  'DRILL_EXCEEDS_MAX_DURATION',
  'ARM_CHALLENGE_EXPIRED',
  'ARM_CHALLENGE_CONSUMED',
  'ARM_CONFIRMATION_MISMATCH',
  'EMERGENCY_STOP_ACTIVE',
  'THERMAL_LIMIT_EXCEEDED',

  // MRV, evidence, passport
  'MRV_INSUFFICIENT_DATA',
  'MRV_NOT_GENERATED',
  'CANONICALIZATION_FAILED',
  'EVIDENCE_HASH_MISMATCH',
  'PASSPORT_BLOCKED',
  'PASSPORT_IMMUTABLE',

  // Agent harness and carbon MRV
  'AGENT_SESSION_NOT_FOUND',
  'AGENT_SESSION_NOT_AWAITING_APPROVAL',
  'AGENT_HARNESS_INVALID_STATE',
  'CARBON_INPUT_INVALID',
  'CARBON_FACTOR_DECLARED_REQUIRED',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.record(z.unknown()).optional(),
    request_id: z.string(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/**
 * Base class for domain errors carrying a stable code (spec §4.1).
 * `details` must never contain credentials, tokens, or raw telemetry (spec §18).
 */
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super('NOT_FOUND', `${resource} not found`, { resource, id }, 404);
  }
}

export class ForbiddenError extends DomainError {
  constructor(detail = 'You do not have permission to perform this action') {
    super('FORBIDDEN', detail, undefined, 403);
  }
}

export class ConflictError extends DomainError {
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details, 409);
  }
}
