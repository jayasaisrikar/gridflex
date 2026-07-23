import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { and, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { schema } from '@gridflex/db/client';
import type { Database } from '@gridflex/db/client';
import {
  DomainError,
  createConstraintsRequestSchema,
  createFacilityRequestSchema,
  createMechanismRequestSchema,
  roleHasPermission,
  updateFacilityRequestSchema,
  updateMechanismRequestSchema,
  uuidSchema,
  type CreateConstraintsRequest,
  type CreateFacilityRequest,
  type CreateMechanismRequest,
  type UpdateFacilityRequest,
  type UpdateMechanismRequest,
  type UserRole,
} from '@gridflex/contracts';
import { DATABASE } from '../../common/database/database.module.js';
import { CurrentUserId } from '../../common/auth/auth.guard.js';
import { OrgScopeService } from '../../common/auth/org-scope.service.js';
import { ZodValidationPipe, zodBody } from '../../common/pipes/zod-validation.pipe.js';

/**
 * Facilities, constraints, and mechanisms (spec §9.1).
 *
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

  @Post()
  @HttpCode(201)
  async create(
    @CurrentUserId() userId: string,
    @Body(zodBody(createFacilityRequestSchema)) body: CreateFacilityRequest,
  ) {
    const organizationId = await this.resolveWritableOrganization(userId, body.organization_id);

    const [collision] = await this.db
      .select({ id: schema.facilities.id })
      .from(schema.facilities)
      .where(
        and(
          eq(schema.facilities.organizationId, organizationId),
          eq(schema.facilities.slug, body.slug),
        ),
      )
      .limit(1);
    if (collision) {
      throw new DomainError(
        'CONFLICT',
        'A facility with this slug already exists in the organization.',
        { field: 'slug' },
        409,
      );
    }

    const facility = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.facilities)
        .values({
          organizationId,
          name: body.name,
          slug: body.slug,
          timezone: body.timezone,
          ...(body.country_code ? { countryCode: body.country_code } : {}),
          ...(body.region ? { region: body.region } : {}),
          ...(body.market ? { market: body.market } : {}),
          ...(body.normal_load_kw ? { normalLoadKw: body.normal_load_kw } : {}),
          ...(body.minimum_safe_load_kw
            ? { minimumSafeLoadKw: body.minimum_safe_load_kw }
            : {}),
          ...(body.maximum_curtailment_kw
            ? { maximumCurtailmentKw: body.maximum_curtailment_kw }
            : {}),
          ...(body.ramp_rate_kw_per_min
            ? { rampRateKwPerMin: body.ramp_rate_kw_per_min }
            : {}),
          ...(body.cooling_reserve_kw ? { coolingReserveKw: body.cooling_reserve_kw } : {}),
        })
        .returning();
      if (!created) throw new Error('Facility insert returned no row');

      await tx.insert(schema.auditLogs).values({
        organizationId,
        facilityId: created.id,
        actorUserId: userId,
        action: 'FACILITY_CREATED',
        objectType: 'facility',
        objectId: created.id,
        afterState: facilityAuditState(created),
      });
      return created;
    });

    return { facility: toFacilityDto(facility) };
  }

  @Get(':facilityId')
  async detail(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
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

  @Patch(':facilityId')
  async update(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Body(zodBody(updateFacilityRequestSchema)) body: UpdateFacilityRequest,
  ) {
    const { organizationId } = await this.scope.requireFacility(
      userId,
      facilityId,
      'facility:write',
    );
    const [before] = await this.db
      .select()
      .from(schema.facilities)
      .where(eq(schema.facilities.id, facilityId))
      .limit(1);
    if (!before) throw new DomainError('NOT_FOUND', 'Facility not found', undefined, 404);

    const normalLoad = body.normal_load_kw ?? before.normalLoadKw;
    const minimumSafe = body.minimum_safe_load_kw ?? before.minimumSafeLoadKw;
    const maximumCurtailment = body.maximum_curtailment_kw ?? before.maximumCurtailmentKw;
    if (normalLoad && minimumSafe && Number(minimumSafe) > Number(normalLoad)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Minimum safe load cannot exceed normal load.',
        { fields: { minimum_safe_load_kw: 'Must be no greater than normal_load_kw' } },
        400,
      );
    }
    if (normalLoad && maximumCurtailment && Number(maximumCurtailment) > Number(normalLoad)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Maximum curtailment cannot exceed normal load.',
        { fields: { maximum_curtailment_kw: 'Must be no greater than normal_load_kw' } },
        400,
      );
    }

    if (body.slug && body.slug !== before.slug) {
      const [collision] = await this.db
        .select({ id: schema.facilities.id })
        .from(schema.facilities)
        .where(
          and(
            eq(schema.facilities.organizationId, organizationId),
            eq(schema.facilities.slug, body.slug),
          ),
        )
        .limit(1);
      if (collision) {
        throw new DomainError('CONFLICT', 'A facility with this slug already exists.', undefined, 409);
      }
    }

    const changes: Partial<typeof schema.facilities.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };
    if (body.name !== undefined) changes.name = body.name;
    if (body.slug !== undefined) changes.slug = body.slug;
    if (body.timezone !== undefined) changes.timezone = body.timezone;
    if (body.country_code !== undefined) changes.countryCode = body.country_code;
    if (body.region !== undefined) changes.region = body.region;
    if (body.market !== undefined) changes.market = body.market;
    if (body.normal_load_kw !== undefined) changes.normalLoadKw = body.normal_load_kw;
    if (body.minimum_safe_load_kw !== undefined) changes.minimumSafeLoadKw = body.minimum_safe_load_kw;
    if (body.maximum_curtailment_kw !== undefined) {
      changes.maximumCurtailmentKw = body.maximum_curtailment_kw;
    }
    if (body.ramp_rate_kw_per_min !== undefined) changes.rampRateKwPerMin = body.ramp_rate_kw_per_min;
    if (body.cooling_reserve_kw !== undefined) changes.coolingReserveKw = body.cooling_reserve_kw;
    if (body.status !== undefined) changes.status = body.status;

    const after = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.facilities)
        .set(changes)
        .where(eq(schema.facilities.id, facilityId))
        .returning();
      if (!updated) throw new Error('Facility update returned no row');
      if (
        body.normal_load_kw !== undefined ||
        body.minimum_safe_load_kw !== undefined ||
        body.maximum_curtailment_kw !== undefined ||
        body.ramp_rate_kw_per_min !== undefined ||
        body.cooling_reserve_kw !== undefined
      ) {
        await tx
          .update(schema.envelopes)
          .set({ status: 'STALE' })
          .where(
            and(
              eq(schema.envelopes.facilityId, facilityId),
              eq(schema.envelopes.status, 'CURRENT'),
            ),
          );
      }
      await tx.insert(schema.auditLogs).values({
        organizationId,
        facilityId,
        actorUserId: userId,
        action: 'FACILITY_UPDATED',
        objectType: 'facility',
        objectId: facilityId,
        beforeState: facilityAuditState(before),
        afterState: facilityAuditState(updated),
      });
      return updated;
    });

    return { facility: toFacilityDto(after) };
  }

  @Get(':facilityId/constraints')
  async constraints(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
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

  @Post(':facilityId/constraints')
  @HttpCode(201)
  async createConstraints(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Body(zodBody(createConstraintsRequestSchema)) body: CreateConstraintsRequest,
  ) {
    const { organizationId } = await this.scope.requireFacility(
      userId,
      facilityId,
      'facility:write',
    );

    const created = await this.db.transaction(async (tx) => {
      // The transaction-scoped advisory lock makes concurrent setup requests
      // serialize before choosing the next immutable version number.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${facilityId}))`);
      const [latest] = await tx
        .select({ version: schema.facilityConstraints.version })
        .from(schema.facilityConstraints)
        .where(eq(schema.facilityConstraints.facilityId, facilityId))
        .orderBy(desc(schema.facilityConstraints.version))
        .limit(1);
      const [row] = await tx
        .insert(schema.facilityConstraints)
        .values({
          facilityId,
          version: (latest?.version ?? 0) + 1,
          minimumSafeLoadKw: body.minimum_safe_load_kw,
          maximumCurtailmentKw: body.maximum_curtailment_kw,
          maximumRampKwPerMin: body.maximum_ramp_kw_per_min,
          maximumDurationMin: body.maximum_duration_min,
          minimumRecoveryMin: body.minimum_recovery_min,
          ...(body.maximum_rebound_kw ? { maximumReboundKw: body.maximum_rebound_kw } : {}),
          ...(body.thermal_limit_c ? { thermalLimitC: body.thermal_limit_c } : {}),
          excludedWorkloads: body.excluded_workloads,
          tenantCarveOuts: body.tenant_carve_outs,
          ...(body.source_note ? { sourceNote: body.source_note } : {}),
          createdBy: userId,
        })
        .returning();
      if (!row) throw new Error('Constraint insert returned no row');
      await tx
        .update(schema.envelopes)
        .set({ status: 'STALE' })
        .where(
          and(
            eq(schema.envelopes.facilityId, facilityId),
            eq(schema.envelopes.status, 'CURRENT'),
          ),
        );
      await tx.insert(schema.auditLogs).values({
        organizationId,
        facilityId,
        actorUserId: userId,
        action: 'FACILITY_CONSTRAINTS_VERSION_CREATED',
        objectType: 'facility_constraints',
        objectId: row.id,
        afterState: { version: row.version },
      });
      return row;
    });

    return { constraints: toConstraintsDto(created) };
  }

  @Get(':facilityId/mechanisms')
  async mechanisms(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'facility:read');
    const rows = await this.db
      .select()
      .from(schema.flexibilityMechanisms)
      .where(eq(schema.flexibilityMechanisms.facilityId, facilityId))
      .orderBy(schema.flexibilityMechanisms.code);
    return { mechanisms: rows.map(toMechanismDto) };
  }

  @Post(':facilityId/mechanisms')
  @HttpCode(201)
  async createMechanism(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Body(zodBody(createMechanismRequestSchema)) body: CreateMechanismRequest,
  ) {
    const { organizationId } = await this.scope.requireFacility(
      userId,
      facilityId,
      'facility:write',
    );
    const [existing] = await this.db
      .select({ id: schema.flexibilityMechanisms.id })
      .from(schema.flexibilityMechanisms)
      .where(
        and(
          eq(schema.flexibilityMechanisms.facilityId, facilityId),
          eq(schema.flexibilityMechanisms.code, body.code),
        ),
      )
      .limit(1);
    if (existing) {
      throw new DomainError('CONFLICT', 'A mechanism with this code already exists.', undefined, 409);
    }

    const created = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.flexibilityMechanisms)
        .values({
          facilityId,
          code: body.code,
          name: body.name,
          ...(body.description ? { description: body.description } : {}),
          mechanismType: body.mechanism_type,
          enabled: body.enabled,
          ...(body.declared_reducible_kw
            ? { declaredReducibleKw: body.declared_reducible_kw }
            : {}),
          ...(body.minimum_load_kw ? { minimumLoadKw: body.minimum_load_kw } : {}),
          ...(body.ramp_rate_kw_per_min
            ? { rampRateKwPerMin: body.ramp_rate_kw_per_min }
            : {}),
          ...(body.maximum_duration_min
            ? { maximumDurationMin: body.maximum_duration_min }
            : {}),
          ...(body.rebound_window_min !== undefined
            ? { reboundWindowMin: body.rebound_window_min }
            : {}),
          ...(body.control_reference ? { controlReference: body.control_reference } : {}),
        })
        .returning();
      if (!row) throw new Error('Mechanism insert returned no row');
      await tx
        .update(schema.envelopes)
        .set({ status: 'STALE' })
        .where(
          and(
            eq(schema.envelopes.facilityId, facilityId),
            eq(schema.envelopes.status, 'CURRENT'),
          ),
        );
      await tx.insert(schema.auditLogs).values({
        organizationId,
        facilityId,
        actorUserId: userId,
        action: 'FLEXIBILITY_MECHANISM_CREATED',
        objectType: 'flexibility_mechanism',
        objectId: row.id,
        afterState: mechanismAuditState(row),
      });
      return row;
    });
    return { mechanism: toMechanismDto(created) };
  }

  @Patch(':facilityId/mechanisms/:mechanismId')
  async updateMechanism(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Param('mechanismId', new ZodValidationPipe(uuidSchema)) mechanismId: string,
    @Body(zodBody(updateMechanismRequestSchema)) body: UpdateMechanismRequest,
  ) {
    const { organizationId } = await this.scope.requireFacility(
      userId,
      facilityId,
      'facility:write',
    );
    const [before] = await this.db
      .select()
      .from(schema.flexibilityMechanisms)
      .where(
        and(
          eq(schema.flexibilityMechanisms.id, mechanismId),
          eq(schema.flexibilityMechanisms.facilityId, facilityId),
        ),
      )
      .limit(1);
    if (!before) throw new DomainError('NOT_FOUND', 'Mechanism not found', undefined, 404);

    const changes: Partial<typeof schema.flexibilityMechanisms.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };
    if (body.name !== undefined) changes.name = body.name;
    if (body.description !== undefined) changes.description = body.description;
    if (body.mechanism_type !== undefined) changes.mechanismType = body.mechanism_type;
    if (body.enabled !== undefined) changes.enabled = body.enabled;
    if (body.declared_reducible_kw !== undefined) changes.declaredReducibleKw = body.declared_reducible_kw;
    if (body.minimum_load_kw !== undefined) changes.minimumLoadKw = body.minimum_load_kw;
    if (body.ramp_rate_kw_per_min !== undefined) changes.rampRateKwPerMin = body.ramp_rate_kw_per_min;
    if (body.maximum_duration_min !== undefined) changes.maximumDurationMin = body.maximum_duration_min;
    if (body.rebound_window_min !== undefined) changes.reboundWindowMin = body.rebound_window_min;
    if (body.control_reference !== undefined) changes.controlReference = body.control_reference;

    const after = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.flexibilityMechanisms)
        .set(changes)
        .where(eq(schema.flexibilityMechanisms.id, mechanismId))
        .returning();
      if (!row) throw new Error('Mechanism update returned no row');
      await tx
        .update(schema.envelopes)
        .set({ status: 'STALE' })
        .where(
          and(
            eq(schema.envelopes.facilityId, facilityId),
            eq(schema.envelopes.status, 'CURRENT'),
          ),
        );
      await tx.insert(schema.auditLogs).values({
        organizationId,
        facilityId,
        actorUserId: userId,
        action: 'FLEXIBILITY_MECHANISM_UPDATED',
        objectType: 'flexibility_mechanism',
        objectId: mechanismId,
        beforeState: mechanismAuditState(before),
        afterState: mechanismAuditState(row),
      });
      return row;
    });
    return { mechanism: toMechanismDto(after) };
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

  private async resolveWritableOrganization(
    userId: string,
    requestedOrganizationId?: string,
  ): Promise<string> {
    const memberships = await this.db
      .select({
        organizationId: schema.organizationMembers.organizationId,
        role: schema.organizationMembers.role,
      })
      .from(schema.organizationMembers)
      .where(eq(schema.organizationMembers.userId, userId));

    const writable = memberships.filter((membership) =>
      roleHasPermission(membership.role as UserRole, 'facility:write'),
    );
    if (requestedOrganizationId) {
      const match = writable.find((membership) => membership.organizationId === requestedOrganizationId);
      if (!match) {
        throw new DomainError('NOT_FOUND', 'Organization not found', undefined, 404);
      }
      return match.organizationId;
    }
    if (writable.length === 1) return writable[0]!.organizationId;
    if (writable.length === 0) {
      throw new DomainError('FORBIDDEN', 'You may not create facilities.', undefined, 403);
    }
    throw new DomainError(
      'VALIDATION_FAILED',
      'organization_id is required when you administer more than one organization.',
      { fields: { organization_id: 'Choose an organization' } },
      400,
    );
  }
}

/* ---------- DTO mapping. snake_case out, per spec §9. ---------- */

type FacilityRow = Pick<
  typeof schema.facilities.$inferSelect,
  | 'id'
  | 'organizationId'
  | 'name'
  | 'slug'
  | 'timezone'
  | 'countryCode'
  | 'region'
  | 'market'
  | 'normalLoadKw'
  | 'minimumSafeLoadKw'
  | 'maximumCurtailmentKw'
  | 'rampRateKwPerMin'
  | 'coolingReserveKw'
  | 'status'
  | 'createdAt'
>;

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

function facilityAuditState(row: typeof schema.facilities.$inferSelect): Record<string, unknown> {
  return {
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
  };
}

function mechanismAuditState(
  row: typeof schema.flexibilityMechanisms.$inferSelect,
): Record<string, unknown> {
  return {
    code: row.code,
    name: row.name,
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
