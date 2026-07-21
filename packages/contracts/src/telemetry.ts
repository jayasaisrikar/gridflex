import { z } from 'zod';
import { decimalStringSchema, ratioSchema, utcTimestampSchema, uuidSchema } from './primitives.js';

/** Canonical metrics (spec §10.1). */
export const CANONICAL_METRICS = {
  'facility.active_power_kw': 'kW',
  'facility.energy_kwh_interval': 'kWh',
  'it.active_power_kw': 'kW',
  'cooling.active_power_kw': 'kW',
  'ups.discharge_kw': 'kW',
  'battery.state_of_charge_pct': '%',
  'thermal.max_inlet_c': 'C',
  'scheduler.deferrable_load_kw': 'kW',
  'scheduler.critical_load_kw': 'kW',
} as const;

export type CanonicalMetric = keyof typeof CANONICAL_METRICS;

export const metricKeySchema = z.enum(
  Object.keys(CANONICAL_METRICS) as [CanonicalMetric, ...CanonicalMetric[]],
);

export const telemetryQualitySchema = z.enum([
  'GOOD',
  'ESTIMATED',
  'SUSPECT',
  'MISSING',
  'QUARANTINED',
]);

/**
 * A single reading. `value` is a decimal string end to end — spec §4.1 requires
 * precision-sensitive values to cross the API boundary as strings.
 */
export const telemetryReadingInputSchema = z
  .object({
    metric_key: metricKeySchema,
    measured_at: utcTimestampSchema,
    value: decimalStringSchema,
    unit: z.string().min(1).max(16),
    quality: telemetryQualitySchema.default('GOOD'),
    source_sequence: z.string().max(128).optional(),
  })
  .superRefine((reading, ctx) => {
    // A unit mismatch means the sender and the engine disagree about what the
    // number means. Rejecting is safer than coercing.
    const expected = CANONICAL_METRICS[reading.metric_key];
    if (reading.unit !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unit'],
        message: `Metric ${reading.metric_key} must be reported in ${expected}, received ${reading.unit}`,
      });
    }
  });

export const MAX_BATCH_READINGS = 10_000;

export const telemetryBatchRequestSchema = z.object({
  source_key: z.string().min(1).max(128),
  readings: z.array(telemetryReadingInputSchema).min(1).max(MAX_BATCH_READINGS),
});

/**
 * Idempotent ingestion result (spec §9.2). Exact duplicates succeed with
 * inserted=0; conflicting duplicates are quarantined rather than overwriting an
 * append-only row.
 */
export const telemetryBatchResponseSchema = z.object({
  inserted: z.number().int().min(0),
  duplicates: z.number().int().min(0),
  quarantined: z.number().int().min(0),
  sync_run_id: uuidSchema.nullable(),
});

export const telemetryQualitySummarySchema = z.object({
  facility_id: uuidSchema,
  window_start: utcTimestampSchema,
  window_end: utcTimestampSchema,
  expected_intervals: z.number().int().min(0),
  observed_intervals: z.number().int().min(0),
  completeness: ratioSchema,
  maximum_gap_intervals: z.number().int().min(0),
  last_reading_at: utcTimestampSchema.nullable(),
  is_stale: z.boolean(),
  /** True when this facility's data is simulator-generated (spec §3, §11). */
  contains_simulated_data: z.boolean(),
});

/** CSV import is preview-then-confirm (spec §10.3). */
export const csvPreviewResponseSchema = z.object({
  total_rows: z.number().int().min(0),
  valid_rows: z.number().int().min(0),
  invalid_rows: z.array(
    z.object({
      row_number: z.number().int().min(1),
      reason_code: z.string(),
      detail: z.string(),
    }),
  ),
  detected_interval_seconds: z.number().int().positive().nullable(),
  window_start: utcTimestampSchema.nullable(),
  window_end: utcTimestampSchema.nullable(),
  /** Opaque token the client returns to commit exactly this previewed import. */
  preview_token: z.string(),
});

export type TelemetryBatchRequest = z.infer<typeof telemetryBatchRequestSchema>;
export type TelemetryBatchResponse = z.infer<typeof telemetryBatchResponseSchema>;
export type TelemetryQualitySummary = z.infer<typeof telemetryQualitySummarySchema>;
