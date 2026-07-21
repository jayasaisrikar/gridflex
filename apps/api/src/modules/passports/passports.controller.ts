import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@gridflex/db/client';
import type { Database } from '@gridflex/db/client';
import { verifyPassport } from '@gridflex/engine';
import { DATABASE } from '../../common/database/database.module.js';
import { CurrentUserId } from '../../common/auth/auth.guard.js';
import { OrgScopeService } from '../../common/auth/org-scope.service.js';
import { toRfc3339 } from '../facilities/facilities.controller.js';

/**
 * Passport read and independent verification (spec §9.5, §15.2, §24).
 *
 * The controller performs no assembly and no hashing of its own. Issuance
 * belongs to the engine; this surface reads what was sealed and recomputes the
 * digests so a reviewer can confirm the document has not been altered since.
 */
@Controller()
export class PassportsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly scope: OrgScopeService,
  ) {}

  @Get('facilities/:facilityId/passports/current')
  async current(@CurrentUserId() userId: string, @Param('facilityId') facilityId: string) {
    await this.scope.requireFacility(userId, facilityId, 'passport:read');

    const [passport] = await this.db
      .select()
      .from(schema.passports)
      .where(
        and(eq(schema.passports.facilityId, facilityId), eq(schema.passports.status, 'ISSUED')),
      )
      .orderBy(desc(schema.passports.version))
      .limit(1);

    return { passport: passport ? toPassportDto(passport) : null };
  }

  @Get('facilities/:facilityId/passports')
  async list(@CurrentUserId() userId: string, @Param('facilityId') facilityId: string) {
    await this.scope.requireFacility(userId, facilityId, 'passport:read');

    const passports = await this.db
      .select()
      .from(schema.passports)
      .where(eq(schema.passports.facilityId, facilityId))
      .orderBy(desc(schema.passports.version));

    return { passports: passports.map(toPassportSummaryDto) };
  }

  /**
   * Recomputes both digests from the stored canonical JSON and reports the
   * comparison. Reports rather than throws on a mismatch: a reviewer needs to
   * see what was actually computed, not an error page.
   */
  @Get('passports/:passportId/verify')
  async verify(@CurrentUserId() userId: string, @Param('passportId') passportId: string) {
    const [passport] = await this.db
      .select()
      .from(schema.passports)
      .where(eq(schema.passports.id, passportId))
      .limit(1);

    if (!passport) throw new NotFoundException('Passport not found');
    await this.scope.requireFacility(userId, passport.facilityId, 'passport:read');

    const [evidence] = await this.db
      .select()
      .from(schema.evidenceBundles)
      .where(eq(schema.evidenceBundles.id, passport.evidenceBundleId))
      .limit(1);

    if (!evidence) throw new NotFoundException('Evidence bundle not found');

    const result = verifyPassport({
      passportJson: passport.passportJson as Record<string, never>,
      storedPassportSha256: passport.passportSha256,
      evidenceJson: evidence.canonicalJson as Record<string, never>,
      storedEvidenceSha256: evidence.canonicalSha256,
    });

    return {
      passport_id: passport.id,
      version: passport.version,
      status: passport.status,
      stored_passport_sha256: passport.passportSha256,
      stored_evidence_sha256: evidence.canonicalSha256,
      verified_at: toRfc3339(new Date()),
      ...result,
    };
  }
}

function toPassportSummaryDto(row: typeof schema.passports.$inferSelect) {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    passport_sha256: row.passportSha256,
    issued_at: row.issuedAt ? toRfc3339(row.issuedAt) : null,
    superseded_by: row.supersededBy,
    revocation_reason: row.revocationReason,
  };
}

function toPassportDto(row: typeof schema.passports.$inferSelect) {
  return {
    ...toPassportSummaryDto(row),
    evidence_bundle_id: row.evidenceBundleId,
    envelope_id: row.envelopeId,
    // The sealed document, returned verbatim. Reshaping it here would change
    // what a verifier hashes.
    document: row.passportJson,
  };
}
