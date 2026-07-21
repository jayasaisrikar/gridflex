import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { DomainError } from '@gridflex/contracts';

export interface AccessTokenClaims {
  readonly sub: string;
  readonly email: string;
}

/**
 * Token issuance and verification (spec §8.2).
 *
 * Access tokens: short-lived JWTs (15 min default).
 * Refresh tokens: high-entropy OPAQUE values. Only their SHA-256 hashes are
 * stored, so a database disclosure does not yield usable tokens.
 */
@Injectable()
export class TokenService {
  private readonly secret: Uint8Array;
  private readonly accessTtlMinutes: number;
  private readonly refreshTtlDays: number;

  constructor() {
    const secret = process.env.AUTH_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error('AUTH_SECRET is required and must be at least 32 characters');
    }
    this.secret = new TextEncoder().encode(secret);
    this.accessTtlMinutes = Number(process.env.ACCESS_TOKEN_TTL_MINUTES ?? 15);
    this.refreshTtlDays = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);
  }

  get accessTokenTtlSeconds(): number {
    return this.accessTtlMinutes * 60;
  }

  get refreshTokenTtlMs(): number {
    return this.refreshTtlDays * 24 * 60 * 60 * 1000;
  }

  async issueAccessToken(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ email: claims.email })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setIssuer('gridflex-api')
      .setAudience('gridflex')
      .setExpirationTime(`${this.accessTtlMinutes}m`)
      .sign(this.secret);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: 'gridflex-api',
        audience: 'gridflex',
      });
      if (typeof payload.sub !== 'string') {
        throw new DomainError('UNAUTHENTICATED', 'Malformed access token.', undefined, 401);
      }
      return { sub: payload.sub, email: String(payload.email ?? '') };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      // Never leak why verification failed beyond expiry vs. invalid.
      const expired = (error as { code?: string }).code === 'ERR_JWT_EXPIRED';
      throw new DomainError(
        expired ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED',
        expired ? 'Access token has expired.' : 'Invalid access token.',
        undefined,
        401,
      );
    }
  }

  /**
   * Generates an opaque refresh token and its storage hash.
   * 32 bytes of CSPRNG entropy; the plaintext is returned to the client once and
   * never persisted.
   */
  createRefreshToken(): { token: string; tokenHash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, tokenHash: hashRefreshToken(token) };
  }
}

/** SHA-256 of a refresh token — the only form ever stored (spec §8.2). */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
