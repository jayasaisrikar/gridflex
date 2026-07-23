import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@gridflex/db/client';
import {
  computeEnvelope,
  ENVELOPE_METHODOLOGY_VERSION,
  MINIMUM_COMPLETENESS_FOR_ENVELOPE,
  type EnvelopeInput,
  type MechanismInput,
} from '@gridflex/engine';
import {
  WORKER_DATABASE,
  WORKER_LOGGER,
  WORKER_POOL,
  WORKER_SETTINGS,
  type WorkerDatabase,
  type WorkerLogger,
  type WorkerPool,
  type WorkerSettings,
} from '../runtime.js';

interface EligibleFacility {
  readonly id: string;
  readonly organization_id: string;
  readonly normal_load_kw: string | null;
  readonly p50_load_kw: string;
  readonly minute_count: string;
  readonly constraints_version: number;
  readonly constraints_created_at: string;
  readonly minimum_safe_load_kw: string;
  readonly maximum_curtailment_kw: string;
  readonly maximum_ramp_kw_per_min: string;
  readonly maximum_duration_min: number;
}

type MechanismRow = typeof schema.flexibilityMechanisms.$inferSelect;

export function buildEnvelopeInput(
  facility: EligibleFacility,
  mechanisms: readonly MechanismRow[],
  now: Date,
): EnvelopeInput {
  const minuteCount = Number(facility.minute_count);
  const completeness = Math.min(1, minuteCount / 1_440);

  return {
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
    p50NormalLoadKw: Number(facility.p50_load_kw || facility.normal_load_kw || '0'),
    minimumSafeLoadKw: Number(facility.minimum_safe_load_kw),
    maximumCurtailmentKw: Number(facility.maximum_curtailment_kw),
    maximumRampKwPerMin: Number(facility.maximum_ramp_kw_per_min),
    maximumDurationMin: facility.maximum_duration_min,
    telemetryCompleteness: completeness,
    modelingWindowDays: 14,
    constraintsVersion: facility.constraints_version,
    constraintsAgeDays: Math.max(
      0,
      Math.floor(
        (now.getTime() - new Date(facility.constraints_created_at).getTime()) /
          (24 * 60 * 60 * 1_000),
      ),
    ),
    hasExternalReview: false,
  };
}

@Injectable()
export class EnvelopeJob {
  constructor(
    @Inject(WORKER_POOL) private readonly pool: WorkerPool,
    @Inject(WORKER_DATABASE) private readonly db: WorkerDatabase,
    @Inject(WORKER_SETTINGS) private readonly settings: WorkerSettings,
    @Inject(WORKER_LOGGER) private readonly logger: WorkerLogger,
  ) {}

  async run(): Promise<{
    eligible: number;
    current: number;
    blocked: number;
    failed: number;
  }> {
    const requiredMinutes = Math.ceil(1_440 * MINIMUM_COMPLETENESS_FOR_ENVELOPE);
    const facilities = await this.pool.query<EligibleFacility>(
      `select
         f.id,
         f.organization_id,
         f.normal_load_kw,
         stats.p50_load_kw::text,
         stats.minute_count::text,
         constraints.version as constraints_version,
         constraints.created_at as constraints_created_at,
         constraints.minimum_safe_load_kw,
         constraints.maximum_curtailment_kw,
         constraints.maximum_ramp_kw_per_min,
         constraints.maximum_duration_min
       from facilities f
       join lateral (
         select
           count(distinct date_trunc('minute', tr.measured_at))
             filter (where tr.measured_at >= now() - interval '24 hours') as minute_count,
           percentile_cont(0.5) within group (order by tr.value_double)
             filter (where tr.measured_at >= now() - interval '14 days') as p50_load_kw,
           max(tr.measured_at) as latest_reading
         from telemetry_readings tr
         where tr.facility_id = f.id
           and tr.metric_key = 'facility.active_power_kw'
           and tr.quality in ('GOOD', 'ESTIMATED')
           and tr.measured_at >= now() - interval '14 days'
       ) stats on true
       join lateral (
         select fc.*
         from facility_constraints fc
         where fc.facility_id = f.id
           and fc.effective_from <= now()
           and (fc.effective_to is null or fc.effective_to > now())
         order by fc.version desc
         limit 1
       ) constraints on true
       where f.status = 'ACTIVE'
         and stats.minute_count >= $1
         and stats.latest_reading >= now() - make_interval(mins => $2)
         and stats.p50_load_kw is not null
         and exists (
           select 1 from flexibility_mechanisms fm
           where fm.facility_id = f.id and fm.enabled = true
         )
       order by f.id`,
      [requiredMinutes, this.settings.telemetryStaleMinutes],
    );

    let current = 0;
    let blocked = 0;
    let failed = 0;
    for (const facility of facilities.rows) {
      try {
        const status = await this.recompute(facility);
        if (status === 'CURRENT') current += 1;
        else blocked += 1;
      } catch (error: unknown) {
        failed += 1;
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        this.logger.error(
          { facility_id: facility.id, error_name: errorName },
          'scheduled envelope recompute failed',
        );
        try {
          await this.db.insert(schema.engineRuns).values({
            organizationId: facility.organization_id,
            facilityId: facility.id,
            runType: 'ENVELOPE_RECOMPUTE',
            status: 'FAILED',
            methodologyVersion: ENVELOPE_METHODOLOGY_VERSION,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            errorCode: 'WORKER_RECOMPUTE_FAILED',
            errorDetail: 'Scheduled recompute failed; inspect protected worker logs.',
          });
        } catch {
          // The original protected log is the useful signal if the database is unavailable.
        }
      }
    }

    return { eligible: facilities.rowCount ?? 0, current, blocked, failed };
  }

  private async recompute(facility: EligibleFacility): Promise<'CURRENT' | 'BLOCKED'> {
    const mechanisms = await this.db
      .select()
      .from(schema.flexibilityMechanisms)
      .where(eq(schema.flexibilityMechanisms.facilityId, facility.id))
      .orderBy(schema.flexibilityMechanisms.code);
    const now = new Date();
    const input = buildEnvelopeInput(facility, mechanisms, now);
    const result = computeEnvelope(input);

    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .insert(schema.engineRuns)
        .values({
          organizationId: facility.organization_id,
          facilityId: facility.id,
          runType: 'ENVELOPE_RECOMPUTE',
          status: result.status === 'BLOCKED' ? 'BLOCKED' : 'SUCCEEDED',
          inputRef: {
            telemetry_completeness: input.telemetryCompleteness,
            constraints_version: input.constraintsVersion,
            mechanism_count: input.mechanisms.length,
            trigger: 'SCHEDULED',
          },
          outputRef: {
            total_reducible_kw: result.totalReducibleKw,
            binding_constraint: result.bindingConstraint,
          },
          methodologyVersion: ENVELOPE_METHODOLOGY_VERSION,
          startedAt: now.toISOString(),
          finishedAt: now.toISOString(),
        })
        .returning({ id: schema.engineRuns.id });
      const runId = run!.id;

      if (result.decisions.length > 0) {
        await tx.insert(schema.engineDecisions).values(
          result.decisions.map((decision) => ({
            engineRunId: runId,
            decisionType: decision.decisionType,
            decisionCode: decision.decisionCode,
            severity: decision.severity,
            facts: decision.facts,
            rulesEvaluated: [...decision.rulesEvaluated],
          })),
        );
      }

      const [maxVersion] = await tx
        .select({ version: sql<number>`coalesce(max(${schema.envelopes.version}), 0)` })
        .from(schema.envelopes)
        .where(eq(schema.envelopes.facilityId, facility.id));
      const nextVersion = Number(maxVersion?.version ?? 0) + 1;
      const status = result.status === 'BLOCKED' ? 'BLOCKED' : 'CURRENT';

      // A blocked recalculation is recorded for review but never invalidates a
      // still-current envelope. The staleness job owns invalidation separately.
      if (status === 'CURRENT') {
        await tx
          .update(schema.envelopes)
          .set({ status: 'SUPERSEDED' })
          .where(
            and(
              eq(schema.envelopes.facilityId, facility.id),
              eq(schema.envelopes.status, 'CURRENT'),
            ),
          );
      }

      const [envelope] = await tx
        .insert(schema.envelopes)
        .values({
          organizationId: facility.organization_id,
          facilityId: facility.id,
          version: nextVersion,
          status,
          asOf: now.toISOString(),
          validUntil:
            status === 'CURRENT'
              ? new Date(
                  now.getTime() + this.settings.envelopeValidityMinutes * 60_000,
                ).toISOString()
              : null,
          totalReducibleKw: result.totalReducibleKw,
          responseTimeSeconds: result.responseTimeSeconds,
          sustainableDurationMin: result.sustainableDurationMin,
          aggregateRampKwPerMin: result.aggregateRampKwPerMin,
          confidenceScore: result.confidenceScore.toFixed(4),
          telemetryCompleteness: result.telemetryCompleteness.toFixed(4),
          methodologyVersion: result.methodologyVersion,
          constraintsVersion: result.constraintsVersion,
          blockedReasons: [...result.blockedReasons],
          summary: {
            binding_constraint: result.bindingConstraint,
            confidence_adjustments: result.confidenceAdjustments,
            scheduled: true,
          },
          createdByEngineRun: runId,
        })
        .returning({ id: schema.envelopes.id });
      const envelopeId = envelope!.id;

      if (result.mechanisms.length > 0) {
        await tx.insert(schema.envelopeMechanisms).values(
          result.mechanisms.map((mechanism) => ({
            envelopeId,
            mechanismId: mechanism.mechanismId,
            provenance: mechanism.provenance,
            reducibleKw: mechanism.reducibleKw,
            responseTimeSeconds: result.responseTimeSeconds,
            rampKwPerMin: mechanism.rampKwPerMin,
            durationMin: mechanism.durationMin,
            confidenceScore: mechanism.confidenceScore.toFixed(4),
            evidenceRefs: [],
            notes: mechanism.notes,
          })),
        );
      }

      await tx.insert(schema.auditLogs).values({
        organizationId: facility.organization_id,
        facilityId: facility.id,
        actorService: 'worker',
        action: 'ENVELOPE_RECOMPUTED',
        objectType: 'envelopes',
        objectId: envelopeId,
        afterState: { version: nextVersion, status, scheduled: true },
      });

      return status;
    });
  }
}
