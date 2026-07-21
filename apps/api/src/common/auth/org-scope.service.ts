import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { schema } from '@gridflex/db/client';
import type { Database } from '@gridflex/db/client';
import { DomainError, roleHasPermission, type Permission, type UserRole } from '@gridflex/contracts';
import { DATABASE } from '../database/database.module.js';

/**
 * Organisation / facility authorisation (spec §18: "Use organization/facility
 * authorization checks on every query").
 *
 * Every facility-scoped request passes through here. The check is a JOIN against
 * organization_members, not a filter applied after loading — a user must never be
 * able to observe that a facility exists by getting a 403 instead of a 404 for
 * one they cannot see. Unauthorised facilities return NOT_FOUND.
 */
@Injectable()
export class OrgScopeService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Resolves a facility the user may access, or throws NOT_FOUND.
   * Also enforces the permission required for the operation.
   */
  async requireFacility(
    userId: string,
    facilityId: string,
    permission: Permission,
  ): Promise<{ facilityId: string; organizationId: string; role: UserRole }> {
    const [row] = await this.db
      .select({
        facilityId: schema.facilities.id,
        organizationId: schema.facilities.organizationId,
        role: schema.organizationMembers.role,
      })
      .from(schema.facilities)
      .innerJoin(
        schema.organizationMembers,
        eq(schema.organizationMembers.organizationId, schema.facilities.organizationId),
      )
      .where(
        and(
          eq(schema.facilities.id, facilityId),
          eq(schema.organizationMembers.userId, userId),
        ),
      )
      .limit(1);

    // Indistinguishable from "does not exist" — deliberate.
    if (!row) {
      throw new DomainError('NOT_FOUND', 'Facility not found', { facility_id: facilityId }, 404);
    }

    const role = row.role as UserRole;
    if (!roleHasPermission(role, permission)) {
      throw new DomainError(
        'FORBIDDEN',
        `Role ${role} may not perform this action.`,
        { required: permission },
        403,
      );
    }

    return { facilityId: row.facilityId, organizationId: row.organizationId, role };
  }

  /** Facilities visible to the user, across every org they belong to. */
  async listFacilities(userId: string) {
    return this.db
      .select({
        id: schema.facilities.id,
        organizationId: schema.facilities.organizationId,
        name: schema.facilities.name,
        slug: schema.facilities.slug,
        timezone: schema.facilities.timezone,
        countryCode: schema.facilities.countryCode,
        region: schema.facilities.region,
        market: schema.facilities.market,
        normalLoadKw: schema.facilities.normalLoadKw,
        minimumSafeLoadKw: schema.facilities.minimumSafeLoadKw,
        maximumCurtailmentKw: schema.facilities.maximumCurtailmentKw,
        rampRateKwPerMin: schema.facilities.rampRateKwPerMin,
        coolingReserveKw: schema.facilities.coolingReserveKw,
        status: schema.facilities.status,
        createdAt: schema.facilities.createdAt,
      })
      .from(schema.facilities)
      .innerJoin(
        schema.organizationMembers,
        eq(schema.organizationMembers.organizationId, schema.facilities.organizationId),
      )
      .where(eq(schema.organizationMembers.userId, userId));
  }
}
