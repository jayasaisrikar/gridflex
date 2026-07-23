import { z } from 'zod';
import { utcTimestampSchema, uuidSchema } from './primitives.js';

export const connectorTypeSchema = z.enum([
  'CSV_UPLOAD',
  'INTERVAL_METER_API',
  'DCIM_API',
  'BMS_API',
  'MODBUS_EXPORT',
  'BACNET_EXPORT',
  'SCHEDULER_API',
  'SIMULATOR',
]);

export const connectorStatusSchema = z.enum([
  'DRAFT',
  'ACTIVE',
  'DEGRADED',
  'ERROR',
  'DISABLED',
]);

export const connectorSchema = z.object({
  id: uuidSchema,
  facility_id: uuidSchema,
  name: z.string(),
  connector_type: connectorTypeSchema,
  status: connectorStatusSchema,
  config_summary: z.record(z.unknown()),
  poll_interval_seconds: z.number().int().min(30).nullable(),
  last_sync_at: utcTimestampSchema.nullable(),
  last_success_at: utcTimestampSchema.nullable(),
  last_error: z.string().nullable(),
  has_configuration: z.boolean(),
  created_at: utcTimestampSchema,
  updated_at: utcTimestampSchema,
});

const configurationSchema = z
  .record(z.unknown())
  .refine((value) => JSON.stringify(value).length <= 64 * 1024, 'Configuration exceeds 64 KiB');

export const createConnectorRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  connector_type: connectorTypeSchema,
  configuration: configurationSchema.optional(),
  poll_interval_seconds: z.number().int().min(30).max(86_400).optional(),
});

export const updateConnectorRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    configuration: configurationSchema.nullable(),
    poll_interval_seconds: z.number().int().min(30).max(86_400).nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be supplied');

export const connectorTestResponseSchema = z.object({
  connector_id: uuidSchema,
  ok: z.boolean(),
  status: connectorStatusSchema,
  checked_at: utcTimestampSchema,
  message: z.string(),
});

export const connectorSyncResponseSchema = z.object({
  connector_id: uuidSchema,
  sync_run_id: uuidSchema,
  status: z.literal('QUEUED'),
});

export type ConnectorType = z.infer<typeof connectorTypeSchema>;
export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;
export type Connector = z.infer<typeof connectorSchema>;
export type CreateConnectorRequest = z.infer<typeof createConnectorRequestSchema>;
export type UpdateConnectorRequest = z.infer<typeof updateConnectorRequestSchema>;
