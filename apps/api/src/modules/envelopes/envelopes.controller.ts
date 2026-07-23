import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { schema } from '@gridflex/db/client';
import type { Database } from '@gridflex/db/client';
import {
  computeEnvelope,
  ENVELOPE_METHODOLOGY_VERSION,
  type MechanismInput,
} from '@gridflex/engine';
import { DomainError, uuidSchema } from '@gridflex/contracts';
import { DATABASE } from '../../common/database/database.module.js';
import { CurrentUserId } from '../../common/auth/auth.guard.js';
import { OrgScopeService } from '../../common/auth/org-scope.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { toRfc3339 } from '../facilities/facilities.controller.js';

/**
 * Envelope computation (spec §9.3, §12).
 *
 * The controller does no arithmetic. It gathers inputs, calls the pure engine,
 * and persists the result together with every decision the engine recorded. That
 * separation is what makes the numbers reproducible: the same inputs through the
 * same methodology version always yield the same envelope, and the engine is
 * tested independently of the database.
 */
@Controller()
export class EnvelopesController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly scope: OrgScopeService,
  ) {}

  @Get('facilities/:facilityId/envelopes/current')
  async current(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'envelope:read');

    const [envelope] = await this.db
      .select()
      .from(schema.envelopes)
      .where(
        and(
          eq(schema.envelopes.facilityId, facilityId),
          eq(schema.envelopes.status, 'CURRENT'),
        ),
      )
      .limit(1);

    if (!envelope) return { envelope: null, mechanisms: [] };

    const mechanisms = await this.loadEnvelopeMechanisms(envelope.id);
    return { envelope: toEnvelopeDto(envelope), mechanisms };
  }

  @Get('facilities/:facilityId/envelopes')
  async history(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'envelope:read');
    const rows = await this.db
      .select()
      .from(schema.envelopes)
      .where(eq(schema.envelopes.facilityId, facilityId))
      .orderBy(desc(schema.envelopes.version));
    return { envelopes: rows.map(toEnvelopeDto) };
  }

  @Get('envelopes/:envelopeId')
  async detail(
    @CurrentUserId() userId: string,
    @Param('envelopeId', new ZodValidationPipe(uuidSchema)) envelopeId: string,
  ) {
    const [envelope] = await this.db
      .select()
      .from(schema.envelopes)
      .where(eq(schema.envelopes.id, envelopeId))
      .limit(1);

    if (!envelope) throw new DomainError('NOT_FOUND', 'Envelope not found', undefined, 404);
    await this.scope.requireFacility(userId, envelope.facilityId, 'envelope:read');

    return {
      envelope: toEnvelopeDto(envelope),
      mechanisms: await this.loadEnvelopeMechanisms(envelope.id),
    };
  }

  @Get('envelopes/:envelopeId/explanation')
  async explanation(
    @CurrentUserId() userId: string,
    @Param('envelopeId', new ZodValidationPipe(uuidSchema)) envelopeId: string,
  ) {
    const [envelope] = await this.db
      .select()
      .from(schema.envelopes)
      .where(eq(schema.envelopes.id, envelopeId))
      .limit(1);

    if (!envelope) throw new DomainError('NOT_FOUND', 'Envelope not found', undefined, 404);
    await this.scope.requireFacility(userId, envelope.facilityId, 'envelope:read');

    const decisions = envelope.createdByEngineRun
      ? await this.db
          .select()
          .from(schema.engineDecisions)
          .where(eq(schema.engineDecisions.engineRunId, envelope.createdByEngineRun))
          .orderBy(schema.engineDecisions.createdAt)
      : [];

    return {
      envelope_id: envelope.id,
      engine_run_id: envelope.createdByEngineRun,
      methodology_version: envelope.methodologyVersion,
      // Every cap that bound the result, so a reviewer can follow the arithmetic.
      decisions: decisions.map((decision) => ({
        decision_type: decision.decisionType,
        decision_code: decision.decisionCode,
        severity: decision.severity,
        facts: decision.facts,
        rules_evaluated: decision.rulesEvaluated,
      })),
      summary: envelope.summary,
      blocked_reasons: envelope.blockedReasons,
    };
  }

  /**
   * Recompute. Creates an engine_run, computes, writes decisions, and atomically
   * promotes the new version to CURRENT while superseding the previous one.
   */
  @Post('facilities/:facilityId/envelopes/recompute')
  @HttpCode(201)
  async recompute(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
  ) {
    const { organizationId } = await this.scope.requireFacility(
      userId,
      facilityId,
      'envelope:recompute',
    );

    const [facility] = await this.db
      .select()
      .from(schema.facilities)
      .where(eq(schema.facilities.id, facilityId))
      .limit(1);
    if (!facility) throw new DomainError('NOT_FOUND', 'Facility not found', undefined, 404);

    const constraintsAsOf = new Date().toISOString();
    const [constraints] = await this.db
      .select()
      .from(schema.facilityConstraints)
      .where(
        and(
          eq(schema.facilityConstraints.facilityId, facilityId),
          lte(schema.facilityConstraints.effectiveFrom, constraintsAsOf),
          or(
            isNull(schema.facilityConstraints.effectiveTo),
            gt(schema.facilityConstraints.effectiveTo, constraintsAsOf),
          ),
        ),
      )
      .orderBy(desc(schema.facilityConstraints.version))
      .limit(1);

    if (!constraints) {
      throw new DomainError(
        'CONSTRAINTS_MISSING',
        'Facility has no safety constraints. An envelope cannot be computed without them.',
        undefined,
        409,
      );
    }

    const mechanisms = await this.db
      .select()
      .from(schema.flexibilityMechanisms)
      .where(eq(schema.flexibilityMechanisms.facilityId, facilityId))
      .orderBy(schema.flexibilityMechanisms.code);

    const telemetry = await this.telemetryQuality(facilityId);
    if (telemetry.isStale) {
      throw new DomainError(
        'ENVELOPE_BLOCKED_DATA_QUALITY',
        'Telemetry is stale. Restore a fresh accepted reading before recomputing the envelope.',
        { last_reading_at: telemetry.lastReadingAt },
        409,
      );
    }
    const completeness = telemetry.completeness;

    const engineInput = {
      mechanisms: mechanisms.map(
        (mechanism): MechanismInput => ({
          id: mechanism.id,
          code: mechanism.code,
          name: mechanism.name,
          enabled: mechanism.enabled,
          declaredReducibleKw:
            mechanism.declaredReducibleKw === null
              ? null
              : Number(mechanism.declaredReducibleKw),
          // No observed or tested caps until telemetry modelling / drills land.
          observedReducibleKw: null,
          constraintCapKw: null,
          rampKwPerMin:
            mechanism.rampRateKwPerMin === null ? null : Number(mechanism.rampRateKwPerMin),
          maximumDurationMin: mechanism.maximumDurationMin,
          reboundWindowMin: mechanism.reboundWindowMin,
          testedReducibleKw: null,
          testCount: 0,
        }),
      ),
      p50NormalLoadKw: Number(facility.normalLoadKw ?? 0),
      minimumSafeLoadKw: Number(constraints.minimumSafeLoadKw),
      maximumCurtailmentKw: Number(constraints.maximumCurtailmentKw),
      maximumRampKwPerMin: Number(constraints.maximumRampKwPerMin),
      maximumDurationMin: constraints.maximumDurationMin,
      telemetryCompleteness: completeness,
      modelingWindowDays: 14,
      constraintsVersion: constraints.version,
      constraintsAgeDays: Math.max(
        0,
        Math.floor(
          (Date.now() - new Date(constraints.createdAt).getTime()) / (24 * 60 * 60 * 1000),
        ),
      ),
      hasExternalReview: false,
    };

    const result = computeEnvelope(engineInput);

    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .insert(schema.engineRuns)
        .values({
          organizationId,
          facilityId,
          runType: 'ENVELOPE_RECOMPUTE',
          status: result.status === 'BLOCKED' ? 'BLOCKED' : 'SUCCEEDED',
          methodologyVersion: ENVELOPE_METHODOLOGY_VERSION,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          inputRef: {
            telemetry_completeness: completeness,
            constraints_version: constraints.version,
            mechanism_count: mechanisms.length,
          },
          outputRef: {
            total_reducible_kw: result.totalReducibleKw,
            binding_constraint: result.bindingConstraint,
          },
        })
        .returning({ id: schema.engineRuns.id });

      const runId = run!.id;

      // Persist every decision — this is the explanation surface.
      if (result.decisions.length > 0) {
        await tx.insert(schema.engineDecisions).values(
          result.decisions.map((decision) => ({
            engineRunId: runId,
            decisionType: decision.decisionType,
            decisionCode: decision.decisionCode,
            severity: decision.severity,
            facts: decision.facts as Record<string, unknown>,
            rulesEvaluated: decision.rulesEvaluated as unknown as string[],
          })),
        );
      }

      // A blocked attempt is retained for review but must not silently erase a
      // still-current position. Staleness propagation owns invalidation.
      if (result.status !== 'BLOCKED') {
        await tx
          .update(schema.envelopes)
          .set({ status: 'SUPERSEDED' })
          .where(
            and(
              eq(schema.envelopes.facilityId, facilityId),
              eq(schema.envelopes.status, 'CURRENT'),
            ),
          );
      }

      const [maxVersion] = await tx
        .select({ version: sql<number>`coalesce(max(version), 0)` })
        .from(schema.envelopes)
        .where(eq(schema.envelopes.facilityId, facilityId));

      const nextVersion = Number(maxVersion?.version ?? 0) + 1;

      const [envelope] = await tx
        .insert(schema.envelopes)
        .values({
          organizationId,
          facilityId,
          version: nextVersion,
          status: result.status === 'BLOCKED' ? 'BLOCKED' : 'CURRENT',
          asOf: new Date().toISOString(),
          totalReducibleKw: result.totalReducibleKw,
          responseTimeSeconds: result.responseTimeSeconds,
          sustainableDurationMin: result.sustainableDurationMin,
          aggregateRampKwPerMin: result.aggregateRampKwPerMin,
          confidenceScore: result.confidenceScore.toFixed(4),
          telemetryCompleteness: result.telemetryCompleteness.toFixed(4),
          methodologyVersion: result.methodologyVersion,
          constraintsVersion: result.constraintsVersion,
          blockedReasons: result.blockedReasons as unknown as object[],
          summary: {
            binding_constraint: result.bindingConstraint,
            confidence_adjustments: result.confidenceAdjustments,
          },
          createdByEngineRun: runId,
        })
        .returning();

      const created = envelope!;

      if (result.mechanisms.length > 0) {
        await tx.insert(schema.envelopeMechanisms).values(
          result.mechanisms.map((mechanism) => ({
            envelopeId: created.id,
            mechanismId: mechanism.mechanismId,
            provenance: mechanism.provenance,
            reducibleKw: mechanism.reducibleKw,
            responseTimeSeconds: result.responseTimeSeconds,
            rampKwPerMin: mechanism.rampKwPerMin,
            durationMin: mechanism.durationMin,
            confidenceScore: mechanism.confidenceScore.toFixed(4),
            evidenceRefs: [] as unknown as object[],
            notes: mechanism.notes,
          })),
        );
      }

      await tx.insert(schema.auditLogs).values({
        organizationId,
        facilityId,
        actorUserId: userId,
        action: 'ENVELOPE_RECOMPUTED',
        objectType: 'envelopes',
        objectId: created.id,
        afterState: { version: nextVersion, status: created.status },
      });

      return {
        envelope: toEnvelopeDto(created),
        mechanisms: await this.loadEnvelopeMechanisms(created.id, tx),
        engine_run_id: runId,
      };
    });
  }

  private async loadEnvelopeMechanisms(envelopeId: string, tx?: Database) {
    const database = tx ?? this.db;
    const rows = await database
      .select({
        mechanismId: schema.envelopeMechanisms.mechanismId,
        code: schema.flexibilityMechanisms.code,
        name: schema.flexibilityMechanisms.name,
        provenance: schema.envelopeMechanisms.provenance,
        reducibleKw: schema.envelopeMechanisms.reducibleKw,
        rampKwPerMin: schema.envelopeMechanisms.rampKwPerMin,
        durationMin: schema.envelopeMechanisms.durationMin,
        confidenceScore: schema.envelopeMechanisms.confidenceScore,
        notes: schema.envelopeMechanisms.notes,
      })
      .from(schema.envelopeMechanisms)
      .innerJoin(
        schema.flexibilityMechanisms,
        eq(schema.flexibilityMechanisms.id, schema.envelopeMechanisms.mechanismId),
      )
      .where(eq(schema.envelopeMechanisms.envelopeId, envelopeId))
      .orderBy(schema.flexibilityMechanisms.code);

    return rows.map((row) => ({
      mechanism_id: row.mechanismId,
      mechanism_code: row.code,
      mechanism_name: row.name,
      provenance: row.provenance,
      reducible_kw: row.reducibleKw,
      ramp_kw_per_min: row.rampKwPerMin,
      duration_min: row.durationMin,
      confidence_score: Number(row.confidenceScore),
      notes: row.notes,
    }));
  }

  private async telemetryQuality(facilityId: string): Promise<{
    completeness: number;
    lastReadingAt: string | null;
    isStale: boolean;
  }> {
    const windowHours = 24;
    const end = new Date();
    const start = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const [observed] = await this.db
      .select({
        count: sql<string>`count(distinct date_trunc('minute', ${schema.telemetryReadings.measuredAt}))::text`,
        latest: sql<string | null>`max(${schema.telemetryReadings.measuredAt})::text`,
      })
      .from(schema.telemetryReadings)
      .where(
        and(
          eq(schema.telemetryReadings.facilityId, facilityId),
          eq(schema.telemetryReadings.metricKey, 'facility.active_power_kw'),
          inArray(schema.telemetryReadings.quality, ['GOOD', 'ESTIMATED']),
          sql`${schema.telemetryReadings.measuredAt} >= ${start.toISOString()}`,
          sql`${schema.telemetryReadings.measuredAt} <= ${end.toISOString()}`,
        ),
      );
    const expected = (windowHours * 3600) / 60;
    const lastReadingAt = observed?.latest ?? null;
    return {
      completeness: Math.min(1, Number(observed?.count ?? '0') / expected),
      lastReadingAt,
      isStale:
        lastReadingAt === null || Date.now() - Date.parse(lastReadingAt) > 180_000,
    };
  }
}

function toEnvelopeDto(row: typeof schema.envelopes.$inferSelect) {
  return {
    id: row.id,
    facility_id: row.facilityId,
    version: row.version,
    status: row.status,
    as_of: toRfc3339(row.asOf),
    valid_until: row.validUntil ? toRfc3339(row.validUntil) : null,
    total_reducible_kw: row.totalReducibleKw,
    response_time_seconds: row.responseTimeSeconds,
    sustainable_duration_min: row.sustainableDurationMin,
    aggregate_ramp_kw_per_min: row.aggregateRampKwPerMin,
    rebound_peak_kw: row.reboundPeakKw,
    confidence_score: Number(row.confidenceScore),
    telemetry_completeness: Number(row.telemetryCompleteness),
    methodology_version: row.methodologyVersion,
    constraints_version: row.constraintsVersion,
    blocked_reasons: row.blockedReasons,
    summary: row.summary,
    created_at: toRfc3339(row.createdAt),
  };
}
