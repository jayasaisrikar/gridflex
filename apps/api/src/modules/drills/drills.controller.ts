import { Controller, Get, Inject, Param } from '@nestjs/common';
import { asc, desc, eq } from 'drizzle-orm';
import { schema } from '@gridflex/db/client';
import type { Database } from '@gridflex/db/client';
import { DomainError } from '@gridflex/contracts';
import { DATABASE } from '../../common/database/database.module.js';
import { CurrentUserId } from '../../common/auth/auth.guard.js';
import { OrgScopeService } from '../../common/auth/org-scope.service.js';
import { toRfc3339 } from '../facilities/facilities.controller.js';

/**
 * Drill read endpoints (spec §9.4).
 *
 * Read-only for now. The write paths (validate / arm-intent / arm-confirm /
 * start / abort / complete / verify) are deliberately NOT exposed yet: the
 * state machine is implemented and tested in @gridflex/engine, but wiring
 * arming to HTTP without the operator-confirmation UI would create a way to arm
 * a drill that bypasses the two-step ceremony spec §13 requires.
 */
@Controller()
export class DrillsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly scope: OrgScopeService,
  ) {}

  @Get('facilities/:facilityId/drills')
  async list(
    @CurrentUserId() userId: string,
    @Param('facilityId') facilityId: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'drill:read');

    const rows = await this.db
      .select()
      .from(schema.drills)
      .where(eq(schema.drills.facilityId, facilityId))
      .orderBy(desc(schema.drills.createdAt));

    return { drills: rows.map(toDrillDto) };
  }

  @Get('drills/:drillId')
  async detail(@CurrentUserId() userId: string, @Param('drillId') drillId: string) {
    const drill = await this.requireDrill(userId, drillId);

    const events = await this.db
      .select()
      .from(schema.drillEvents)
      .where(eq(schema.drillEvents.drillId, drillId))
      .orderBy(asc(schema.drillEvents.occurredAt));

    const [mrv] = await this.db
      .select()
      .from(schema.mrvReports)
      .where(eq(schema.mrvReports.drillId, drillId))
      .limit(1);

    const [evidence] = await this.db
      .select({
        id: schema.evidenceBundles.id,
        schemaVersion: schema.evidenceBundles.schemaVersion,
        sha256: schema.evidenceBundles.canonicalSha256,
        createdAt: schema.evidenceBundles.createdAt,
      })
      .from(schema.evidenceBundles)
      .where(eq(schema.evidenceBundles.drillId, drillId))
      .limit(1);

    return {
      drill: toDrillDto(drill),
      events: events.map(toEventDto),
      mrv: mrv ? toMrvDto(mrv) : null,
      evidence: evidence
        ? {
            id: evidence.id,
            schema_version: evidence.schemaVersion,
            canonical_sha256: evidence.sha256,
            created_at: toRfc3339(evidence.createdAt),
          }
        : null,
    };
  }

  @Get('drills/:drillId/events')
  async events(@CurrentUserId() userId: string, @Param('drillId') drillId: string) {
    await this.requireDrill(userId, drillId);
    const rows = await this.db
      .select()
      .from(schema.drillEvents)
      .where(eq(schema.drillEvents.drillId, drillId))
      .orderBy(asc(schema.drillEvents.occurredAt));
    return { events: rows.map(toEventDto) };
  }

  @Get('drills/:drillId/mrv')
  async mrv(@CurrentUserId() userId: string, @Param('drillId') drillId: string) {
    await this.requireDrill(userId, drillId);
    const [report] = await this.db
      .select()
      .from(schema.mrvReports)
      .where(eq(schema.mrvReports.drillId, drillId))
      .limit(1);

    if (!report) {
      throw new DomainError(
        'MRV_NOT_GENERATED',
        'No MRV report exists for this drill.',
        undefined,
        404,
      );
    }
    return { mrv: toMrvDto(report) };
  }

  private async requireDrill(userId: string, drillId: string) {
    const [drill] = await this.db
      .select()
      .from(schema.drills)
      .where(eq(schema.drills.id, drillId))
      .limit(1);

    if (!drill) throw new DomainError('NOT_FOUND', 'Drill not found', undefined, 404);
    await this.scope.requireFacility(userId, drill.facilityId, 'drill:read');
    return drill;
  }
}

function toDrillDto(row: typeof schema.drills.$inferSelect) {
  return {
    id: row.id,
    facility_id: row.facilityId,
    envelope_id: row.envelopeId,
    name: row.name,
    status: row.status,
    requested_reduction_kw: row.requestedReductionKw,
    planned_start_at: toRfc3339(row.plannedStartAt),
    planned_end_at: toRfc3339(row.plannedEndAt),
    baseline_method: row.baselineMethod,
    // Simulated / replayed drills must be labelled wherever they appear (spec §3).
    simulation_mode: row.simulationMode,
    replay_mode: row.replayMode,
    started_at: row.startedAt ? toRfc3339(row.startedAt) : null,
    ended_at: row.endedAt ? toRfc3339(row.endedAt) : null,
    abort_reason_code: row.abortReasonCode,
    created_at: toRfc3339(row.createdAt),
  };
}

function toEventDto(row: typeof schema.drillEvents.$inferSelect) {
  return {
    id: String(row.id),
    event_type: row.eventType,
    occurred_at: toRfc3339(row.occurredAt),
    actor_user_id: row.actorUserId,
    actor_service: row.actorService,
    reason_code: row.reasonCode,
    payload: row.payload,
    correlation_id: row.correlationId,
  };
}

function toMrvDto(row: typeof schema.mrvReports.$inferSelect) {
  return {
    id: row.id,
    drill_id: row.drillId,
    methodology_version: row.methodologyVersion,
    interval_seconds: row.intervalSeconds,
    // bigint Wh as strings — exactness must survive the boundary (spec §4.1).
    committed_energy_wh: String(row.committedEnergyWh),
    delivered_energy_wh: String(row.deliveredEnergyWh),
    average_delivered_kw: row.averageDeliveredKw,
    performance_bps: row.performanceBps,
    telemetry_completeness: Number(row.telemetryCompleteness),
    maximum_gap_intervals: row.maximumGapIntervals,
    rebound_energy_wh: row.reboundEnergyWh === null ? null : String(row.reboundEnergyWh),
    baseline_series: row.baselineSeries,
    actual_series: row.actualSeries,
    quality_blocks: row.qualityBlocks,
    generated_at: toRfc3339(row.generatedAt),
  };
}
