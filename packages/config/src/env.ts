import { z } from 'zod';

/**
 * Environment parsing for every GridFlex process.
 *
 * Rules enforced here rather than by convention:
 *  - CONNECTOR_ENCRYPTION_KEY must differ from AUTH_SECRET (spec 18).
 *  - Secrets are never logged or re-exported; callers get typed values only.
 *  - Parsing throws loudly at boot so a misconfigured process never serves traffic.
 */

const nonEmpty = z.string().trim().min(1);

const baseSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: nonEmpty.refine(
    (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
    'DATABASE_URL must be a postgres:// or postgresql:// connection string',
  ),
});

const authSchema = z.object({
  AUTH_SECRET: nonEmpty.min(32, 'AUTH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  CONNECTOR_ENCRYPTION_KEY: nonEmpty.min(
    32,
    'CONNECTOR_ENCRYPTION_KEY must be at least 32 characters',
  ),
});

const apiSchema = baseSchema.merge(authSchema).extend({
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  STORAGE_ROOT: nonEmpty.default('./.data/gridflex'),
});

const distinctSecrets = <T extends { AUTH_SECRET: string; CONNECTOR_ENCRYPTION_KEY: string }>(
  schema: z.ZodType<T>,
): z.ZodEffects<z.ZodType<T>, T, unknown> =>
  schema.superRefine((value, ctx) => {
    if (value.AUTH_SECRET === value.CONNECTOR_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CONNECTOR_ENCRYPTION_KEY'],
        message:
          'CONNECTOR_ENCRYPTION_KEY must be distinct from AUTH_SECRET so that compromising one does not expose connector credentials.',
      });
    }
  });

export const apiEnvSchema = distinctSecrets(apiSchema);
export const workerEnvSchema = distinctSecrets(
  apiSchema.omit({ API_PORT: true }).extend({
    WORKER_INSTANCE_ID: nonEmpty.default('worker-local'),
  }),
);

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * Parses and returns typed env. On failure the error lists offending KEYS ONLY —
 * never their values, so a crash log can be pasted into an issue safely.
 */
export function parseEnv<T>(schema: z.ZodType<T>, source: NodeJS.ProcessEnv = process.env): T {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const problems = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${problems}`);
}
