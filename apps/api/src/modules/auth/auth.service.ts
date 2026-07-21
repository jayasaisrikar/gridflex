import { Inject, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@gridflex/db/client';
import type { Database } from '@gridflex/db/client';
import {
  DomainError,
  type CurrentUser,
  type TokenPair,
  type UserRole,
} from '@gridflex/contracts';
import { DATABASE } from '../../common/database/database.module.js';
import { TokenService, hashRefreshToken } from './token.service.js';

/**
 * Argon2id parameters. Deliberately explicit rather than relying on library
 * defaults, so a dependency upgrade cannot silently weaken password hashing.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
} as const;

export interface RequestContext {
  readonly ip?: string;
  readonly userAgent?: string;
}

/**
 * Internal signal that a rotated refresh token was replayed.
 *
 * Exists so the rotation transaction can abort while the family revocation is
 * committed independently by the caller. Never reaches the client.
 */
class RefreshReuseDetected extends Error {
  constructor(
    public readonly familyId: string,
    public readonly userId: string,
  ) {
    super('Refresh token reuse detected');
    this.name = 'RefreshReuseDetected';
  }
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Creates the first owner. Works ONLY when no users exist and is disabled
   * forever afterwards (spec §8.2).
   *
   * The check and the insert share a transaction so two concurrent requests
   * cannot both observe an empty table and both create an owner.
   */
  async bootstrapOwner(input: {
    email: string;
    displayName: string;
    password: string;
    organizationName: string;
    organizationSlug: string;
  }): Promise<{ userId: string; organizationId: string }> {
    const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);

    return this.db.transaction(async (tx) => {
      // Lock against concurrent bootstrap attempts.
      const existing = await tx.execute<{ count: string }>(
        sql`select count(*)::text as count from app_users`,
      );
      const userCount = Number(existing.rows[0]?.count ?? '0');
      if (userCount > 0) {
        throw new DomainError(
          'BOOTSTRAP_ALREADY_COMPLETED',
          'Owner bootstrap is permanently disabled because an account already exists.',
          undefined,
          409,
        );
      }

      const [organization] = await tx
        .insert(schema.organizations)
        .values({ name: input.organizationName, slug: input.organizationSlug })
        .returning({ id: schema.organizations.id });

      const [user] = await tx
        .insert(schema.appUsers)
        .values({
          email: input.email,
          displayName: input.displayName,
          passwordHash,
        })
        .returning({ id: schema.appUsers.id });

      if (!organization || !user) {
        throw new DomainError('INTERNAL_ERROR', 'Bootstrap failed.', undefined, 500);
      }

      await tx.insert(schema.organizationMembers).values({
        organizationId: organization.id,
        userId: user.id,
        role: 'OWNER',
      });

      await tx.insert(schema.auditLogs).values({
        organizationId: organization.id,
        actorUserId: user.id,
        action: 'AUTH_BOOTSTRAP_OWNER',
        objectType: 'app_users',
        objectId: user.id,
      });

      return { userId: user.id, organizationId: organization.id };
    });
  }

  /** True when no account exists yet, so the UI can offer bootstrap. */
  async isBootstrapAvailable(): Promise<boolean> {
    const result = await this.db.execute<{ count: string }>(
      sql`select count(*)::text as count from app_users`,
    );
    return Number(result.rows[0]?.count ?? '0') === 0;
  }

  async login(
    email: string,
    password: string,
    context: RequestContext,
  ): Promise<TokenPair> {
    const [user] = await this.db
      .select({
        id: schema.appUsers.id,
        email: schema.appUsers.email,
        passwordHash: schema.appUsers.passwordHash,
        isActive: schema.appUsers.isActive,
      })
      .from(schema.appUsers)
      .where(eq(schema.appUsers.email, email))
      .limit(1);

    // Uniform failure regardless of whether the account exists, so login cannot
    // be used to enumerate registered email addresses.
    const invalid = new DomainError(
      'INVALID_CREDENTIALS',
      'Email or password is incorrect.',
      undefined,
      401,
    );

    if (!user) {
      // Spend comparable time so timing does not reveal account existence.
      await argon2.hash(password, ARGON2_OPTIONS).catch(() => undefined);
      throw invalid;
    }

    const passwordMatches = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!passwordMatches || !user.isActive) throw invalid;

    await this.db
      .update(schema.appUsers)
      .set({ lastLoginAt: new Date().toISOString() })
      .where(eq(schema.appUsers.id, user.id));

    return this.issueTokenPair(user.id, user.email, crypto.randomUUID(), context);
  }

  /**
   * Rotates a refresh token (spec §8.2).
   *
   * Reuse of an already-rotated token means the token was captured, so the
   * ENTIRE family is revoked — not just the presented token. That converts a
   * stolen-token incident into a forced re-login rather than silent persistence.
   */
  async refresh(refreshToken: string, context: RequestContext): Promise<TokenPair> {
    const tokenHash = hashRefreshToken(refreshToken);

    try {
      return await this.rotate(tokenHash, context);
    } catch (error) {
      if (error instanceof RefreshReuseDetected) {
        // CRITICAL: the revocation must be committed in its OWN transaction.
        // Revoking inside the rotation transaction and then throwing would roll
        // the revocation back, leaving the stolen token family fully usable —
        // the exact failure this defence exists to prevent.
        await this.revokeFamily(error.familyId, error.userId);
        throw new DomainError(
          'TOKEN_REUSE_DETECTED',
          'This session has been revoked because a refresh token was reused. Please sign in again.',
          undefined,
          401,
        );
      }
      throw error;
    }
  }

  /** Revokes every live token in a family and records the incident. Committed separately. */
  private async revokeFamily(familyId: string, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.authRefreshTokens)
        .set({ revokedAt: new Date().toISOString() })
        .where(
          and(
            eq(schema.authRefreshTokens.familyId, familyId),
            isNull(schema.authRefreshTokens.revokedAt),
          ),
        );

      await tx.insert(schema.auditLogs).values({
        actorUserId: userId,
        action: 'AUTH_REFRESH_REUSE_DETECTED',
        objectType: 'auth_refresh_tokens',
        objectId: familyId,
      });
    });

    this.logger.warn(
      { user_id: userId, family_id: familyId },
      'Refresh token reuse detected; family revoked',
    );
  }

  private async rotate(tokenHash: string, context: RequestContext): Promise<TokenPair> {
    return this.db.transaction(async (tx) => {
      const [stored] = await tx
        .select({
          id: schema.authRefreshTokens.id,
          userId: schema.authRefreshTokens.userId,
          familyId: schema.authRefreshTokens.familyId,
          expiresAt: schema.authRefreshTokens.expiresAt,
          revokedAt: schema.authRefreshTokens.revokedAt,
        })
        .from(schema.authRefreshTokens)
        .where(eq(schema.authRefreshTokens.tokenHash, tokenHash))
        .limit(1);

      const invalid = new DomainError(
        'UNAUTHENTICATED',
        'Refresh token is invalid.',
        undefined,
        401,
      );
      if (!stored) throw invalid;

      if (stored.revokedAt !== null) {
        // Replay of an already-rotated token. Signal the caller to revoke the
        // family in a SEPARATE committed transaction — doing it here would be
        // rolled back by the throw that follows.
        throw new RefreshReuseDetected(stored.familyId, stored.userId);
      }

      if (Date.parse(stored.expiresAt) <= Date.now()) throw invalid;

      const [user] = await tx
        .select({ email: schema.appUsers.email, isActive: schema.appUsers.isActive })
        .from(schema.appUsers)
        .where(eq(schema.appUsers.id, stored.userId))
        .limit(1);
      if (!user || !user.isActive) throw invalid;

      // Mark the presented token as rotated.
      await tx
        .update(schema.authRefreshTokens)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(schema.authRefreshTokens.id, stored.id));

      return this.issueTokenPair(stored.userId, user.email, stored.familyId, context, tx);
    });
  }

  /** Revokes every live token in the user's families (spec §8.2). */
  async logout(userId: string): Promise<void> {
    await this.db
      .update(schema.authRefreshTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(
        and(
          eq(schema.authRefreshTokens.userId, userId),
          isNull(schema.authRefreshTokens.revokedAt),
        ),
      );
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const [user] = await this.db
      .select({ passwordHash: schema.appUsers.passwordHash })
      .from(schema.appUsers)
      .where(eq(schema.appUsers.id, userId))
      .limit(1);

    if (!user || !(await argon2.verify(user.passwordHash, currentPassword).catch(() => false))) {
      throw new DomainError(
        'INVALID_CREDENTIALS',
        'Current password is incorrect.',
        undefined,
        401,
      );
    }

    const passwordHash = await argon2.hash(newPassword, ARGON2_OPTIONS);
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.appUsers)
        .set({ passwordHash })
        .where(eq(schema.appUsers.id, userId));

      // A password change invalidates every existing session.
      await tx
        .update(schema.authRefreshTokens)
        .set({ revokedAt: new Date().toISOString() })
        .where(
          and(
            eq(schema.authRefreshTokens.userId, userId),
            isNull(schema.authRefreshTokens.revokedAt),
          ),
        );

      await tx.insert(schema.auditLogs).values({
        actorUserId: userId,
        action: 'AUTH_PASSWORD_CHANGED',
        objectType: 'app_users',
        objectId: userId,
      });
    });
  }

  async currentUser(userId: string): Promise<CurrentUser> {
    const [user] = await this.db
      .select({
        id: schema.appUsers.id,
        email: schema.appUsers.email,
        displayName: schema.appUsers.displayName,
        isActive: schema.appUsers.isActive,
        lastLoginAt: schema.appUsers.lastLoginAt,
      })
      .from(schema.appUsers)
      .where(eq(schema.appUsers.id, userId))
      .limit(1);

    if (!user) {
      throw new DomainError('UNAUTHENTICATED', 'Account no longer exists.', undefined, 401);
    }

    const memberships = await this.db
      .select({
        organizationId: schema.organizationMembers.organizationId,
        organizationName: schema.organizations.name,
        role: schema.organizationMembers.role,
      })
      .from(schema.organizationMembers)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.organizationMembers.organizationId),
      )
      .where(eq(schema.organizationMembers.userId, userId));

    return {
      id: user.id,
      email: user.email,
      display_name: user.displayName,
      is_active: user.isActive,
      last_login_at: toRfc3339(user.lastLoginAt),
      memberships: memberships.map((membership) => ({
        organization_id: membership.organizationId,
        organization_name: membership.organizationName,
        role: membership.role as UserRole,
      })),
    };
  }

  private async issueTokenPair(
    userId: string,
    email: string,
    familyId: string,
    context: RequestContext,
    tx?: Database,
  ): Promise<TokenPair> {
    const database = tx ?? this.db;
    const accessToken = await this.tokens.issueAccessToken({ sub: userId, email });
    const { token, tokenHash } = this.tokens.createRefreshToken();

    await database.insert(schema.authRefreshTokens).values({
      userId,
      familyId,
      tokenHash,
      expiresAt: new Date(Date.now() + this.tokens.refreshTokenTtlMs).toISOString(),
      ...(context.ip ? { createdIp: context.ip } : {}),
      ...(context.userAgent ? { userAgent: context.userAgent } : {}),
    });

    return {
      access_token: accessToken,
      refresh_token: token,
      token_type: 'Bearer',
      expires_in: this.tokens.accessTokenTtlSeconds,
    };
  }
}

function toRfc3339(value: string | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
