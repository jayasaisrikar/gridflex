import { z } from 'zod';
import { userRoleSchema, utcTimestampSchema, uuidSchema } from './primitives.js';

/** Spec §8.2: passwords require 12 characters minimum, hashed with Argon2id. */
export const MINIMUM_PASSWORD_LENGTH = 12;

export const passwordSchema = z
  .string()
  .min(MINIMUM_PASSWORD_LENGTH, `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters`)
  .max(256, 'Password must be at most 256 characters');

export const emailSchema = z.string().email().max(320).toLowerCase();

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

export const bootstrapOwnerRequestSchema = z.object({
  email: emailSchema,
  display_name: z.string().min(1).max(200),
  password: passwordSchema,
  organization_name: z.string().min(1).max(200),
  organization_slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens'),
});

export const changePasswordRequestSchema = z.object({
  current_password: z.string().min(1),
  new_password: passwordSchema,
});

/**
 * Refresh tokens are opaque high-entropy values (spec §8.2). Only their SHA-256
 * hashes are stored, and they rotate on every use with family-reuse detection.
 * The token itself never appears in a log or a response body field named
 * anything the logger redactor doesn't cover.
 */
export const refreshRequestSchema = z.object({
  refresh_token: z.string().min(1),
});

export const tokenPairSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
});

export const currentUserSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  display_name: z.string(),
  is_active: z.boolean(),
  last_login_at: utcTimestampSchema.nullable(),
  memberships: z.array(
    z.object({
      organization_id: uuidSchema,
      organization_name: z.string(),
      role: userRoleSchema,
    }),
  ),
});

/**
 * Permission matrix (spec §8.1). Encoded once here so the API guard and the web
 * UI cannot disagree about who may do what.
 */
export const PERMISSIONS = {
  'facility:read': ['OWNER', 'FACILITY_ADMIN', 'OPS_ENGINEER', 'REVIEWER', 'VIEWER'],
  'facility:write': ['OWNER', 'FACILITY_ADMIN'],
  'connector:read': ['OWNER', 'FACILITY_ADMIN', 'OPS_ENGINEER', 'REVIEWER'],
  'connector:write': ['OWNER', 'FACILITY_ADMIN'],
  'telemetry:read': ['OWNER', 'FACILITY_ADMIN', 'OPS_ENGINEER', 'REVIEWER', 'VIEWER'],
  'telemetry:write': ['OWNER', 'FACILITY_ADMIN', 'OPS_ENGINEER'],
  'envelope:read': ['OWNER', 'FACILITY_ADMIN', 'OPS_ENGINEER', 'REVIEWER', 'VIEWER'],
  'envelope:recompute': ['OWNER', 'FACILITY_ADMIN', 'OPS_ENGINEER'],
  'drill:read': ['OWNER', 'FACILITY_ADMIN', 'OPS_ENGINEER', 'REVIEWER', 'VIEWER'],
  'drill:plan': ['OWNER', 'FACILITY_ADMIN', 'OPS_ENGINEER'],
  'drill:arm': ['OWNER', 'FACILITY_ADMIN', 'OPS_ENGINEER'],
  'drill:emergency_stop': ['OWNER', 'FACILITY_ADMIN', 'OPS_ENGINEER'],
  'passport:read': ['OWNER', 'FACILITY_ADMIN', 'OPS_ENGINEER', 'REVIEWER', 'VIEWER'],
  'passport:issue': ['OWNER', 'FACILITY_ADMIN'],
  'export:create': ['OWNER', 'FACILITY_ADMIN', 'REVIEWER'],
  'audit:read': ['OWNER', 'FACILITY_ADMIN', 'REVIEWER'],
  'member:manage': ['OWNER'],
} as const satisfies Record<string, readonly z.infer<typeof userRoleSchema>[]>;

export type Permission = keyof typeof PERMISSIONS;

export function roleHasPermission(
  role: z.infer<typeof userRoleSchema>,
  permission: Permission,
): boolean {
  return (PERMISSIONS[permission] as readonly string[]).includes(role);
}

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type TokenPair = z.infer<typeof tokenPairSchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
