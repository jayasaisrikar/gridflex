import { Controller, Get, Inject, Param } from '@nestjs/common';
import { and, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { schema } from '@gridflex/db/client';
import type { Database } from '@gridflex/db/client';
import { DATABASE } from '../../common/database/database.module.js';
import { CurrentUserId } from '../../common/auth/auth.guard.js';
import { OrgScopeService } from '../../common/auth/org-scope.service.js';

/**
 * Facilities, constraints, and mechanisms (spec §9.1).
 *
 * Read endpoints only for now — write paths land with the facility-setup UI.
 * numeric columns arrive as strings from the driver and are passed through
 * unchanged (spec §4.1): converting them to JS numbers here would silently
 * degrade precision before the value ever reaches the engine.
 */
@Controller('facilities')
export class FacilitiesController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly scope: OrgScopeService,
  ) {}

  @Get()
  async list(@CurrentUserId() userId: string) {
    const facilities = await this.scope.listFacilities(userId);
    return { facilities: facilities.map(toFacilityDto) };
  }

  @Get(':facilityId')
  async detail(
    @CurrentUserId() userId: string,
    @Param('facilityId') facilityId: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'facility:read');

    const [facility] = await this.db
      .select()
      .from(schema.facilities)
      .where(eq(schema.facilities.id, facilityId))
      .limit(1);

    const constraints = await this.activeConstraints(facilityId);
    const mechanisms = await this.db
      .select()
      .from(schema.flexibilityMechanisms)
      .where(eq(schema.flexibilityMechanisms.facilityId, facilityId))
      .orderBy(schema.flexibilityMechanisms.code);

    return {
      facility: facility ? toFacilityDto(facility) : null,
      constraints: constraints ? toConstraintsDto(constraints) : null,
      mechanisms: mechanisms.map(toMechanismDto),
    };
  }

  @Get(':facilityId/constraints')
  async constraints(
    @CurrentUserId() userId: string,
    @Param('facilityId') facilityId: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'facility:read');
    const rows = await this.db
      .select()
      .from(schema.facilityConstraints)
      .where(eq(schema.facilityConstraints.facilityId, facilityId))
      .orderBy(desc(schema.facilityConstraints.version));
    // Versions are never edited in place — the full history is the audit trail.
    return { constraints: rows.map(toConstraintsDto) };
  }

  @Get(':facilityId/mechanisms')
  async mechanisms(
    @CurrentUserId() userId: string,
    @Param('facilityId') facilityId: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'facility:read');
    const rows = await this.db
      .select()
      .from(schema.flexibilityMechanisms)
      .where(eq(schema.flexibilityMechanisms.facilityId, facilityId))
      .orderBy(schema.flexibilityMechanisms.code);
    return { mechanisms: rows.map(toMechanismDto) };
  }

  /**
   * The constraint version in force right now.
   *
   * "In force" means effective_from has passed and effective_to is either unset
   * or still in the future. Taking merely the highest version would return a
   * future-dated revision that is not yet binding — an envelope computed against
   * it would claim limits nobody has authorised yet.
   */
  private async activeConstraints(facilityId: string) {
    const now = new Date().toISOString();
    const [row] = await this.db
      .select()
      .from(schema.facilityConstraints)
      .where(
        and(
          eq(schema.facilityConstraints.facilityId, facilityId),
          lte(schema.facilityConstraints.effectiveFrom, now),
          or(
            isNull(schema.facilityConstraints.effectiveTo),
            gt(schema.facilityConstraints.effectiveTo, now),
          ),
        ),
      )
      .orderBy(desc(schema.facilityConstraints.version))
      .limit(1);
    return row ?? null;
  }
}

/* ---------- DTO mapping. snake_case out, per spec §9. ---------- */

type FacilityRow = Awaited<ReturnType<OrgScopeService['listFacilities']>>[number] &
  Partial<{ metadata: unknown }>;

function toFacilityDto(row: FacilityRow) {
  return {
    id: row.id,
    organization_id: row.organizationId,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    country_code: row.countryCode,
    region: row.region,
    market: row.market,
    normal_load_kw: row.normalLoadKw,
    minimum_safe_load_kw: row.minimumSafeLoadKw,
    maximum_curtailment_kw: row.maximumCurtailmentKw,
    ramp_rate_kw_per_min: row.rampRateKwPerMin,
    cooling_reserve_kw: row.coolingReserveKw,
    status: row.status,
    created_at: toRfc3339(row.createdAt),
  };
}

function toConstraintsDto(row: typeof schema.facilityConstraints.$inferSelect) {
  return {
    id: row.id,
    version: row.version,
    effective_from: toRfc3339(row.effectiveFrom),
    effective_to: row.effectiveTo ? toRfc3339(row.effectiveTo) : null,
    minimum_safe_load_kw: row.minimumSafeLoadKw,
    maximum_curtailment_kw: row.maximumCurtailmentKw,
    maximum_ramp_kw_per_min: row.maximumRampKwPerMin,
    maximum_duration_min: row.maximumDurationMin,
    minimum_recovery_min: row.minimumRecoveryMin,
    maximum_rebound_kw: row.maximumReboundKw,
    thermal_limit_c: row.thermalLimitC,
    excluded_workloads: row.excludedWorkloads,
    source_note: row.sourceNote,
  };
}

function toMechanismDto(row: typeof schema.flexibilityMechanisms.$inferSelect) {
  return {
    id: row.id,
    facility_id: row.facilityId,
    code: row.code,
    name: row.name,
    description: row.description,
    mechanism_type: row.mechanismType,
    enabled: row.enabled,
    declared_reducible_kw: row.declaredReducibleKw,
    minimum_load_kw: row.minimumLoadKw,
    ramp_rate_kw_per_min: row.rampRateKwPerMin,
    maximum_duration_min: row.maximumDurationMin,
    rebound_window_min: row.reboundWindowMin,
    control_reference: row.controlReference,
  };
}

export function toRfc3339(value: string | Date): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
