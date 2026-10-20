import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@gridflex/db/client';
import type { Database } from '@gridflex/db/client';
import {
  CARBON_MRV_VERSION,
  computeCarbonReport,
  type GridEmissionFactor,
} from '@gridflex/engine';
import { DomainError, uuidSchema } from '@gridflex/contracts';
import { z } from 'zod';
import { DATABASE } from '../../common/database/database.module.js';
import { CurrentUserId } from '../../common/auth/auth.guard.js';
import { OrgScopeService } from '../../common/auth/org-scope.service.js';
import {
  ZodValidationPipe,
  zodBody,
} from '../../common/pipes/zod-validation.pipe.js';
import { toRfc3339 } from '../facilities/facilities.controller.js';
/**
 * Agent harness endpoints (Product & Build Doc P0 #2).
 *
 * The controller persists what the harness recorded — it never decides what
 * the agent may do. Authorization happened in the deterministic orchestrator
 * before any executor ran; this layer only books the transcript and exposes
 * it to the console. Carbon reports are computed here because the inputs are
 * verified MRV facts and a declared factor; the arithmetic stays in the
 * engine, and the sealed report lands in the database as evidence.
 */

const startSessionSchema = z.object({
  facility_id: uuidSchema,
  situation: z.string().trim().min(1).max(2_000),
  model_id: z.string().trim().min(1).max(200),
  steps: z
    .array(
      z.object({
        step: z.number().int().positive(),
        proposed: z.object({
          name: z.string().min(1),
          arguments: z.record(z.string(), z.unknown()).default({}),
        }),
        authorized: z.boolean(),
        refusalCodes: z.array(z.string()).default([]),
        reasoning: z.string().default(''),
      }),
    )
    .max(64)
    .default([]),
  status: z.enum([
    'RUNNING',
    'AWAITING_APPROVAL',
    'COMPLETED',
    'REFUSED',
    'ABORTED',
    'STEP_BUDGET_EXHAUSTED',
  ]),
  plan_fingerprint: z.string().max(500).nullable().default(null),
  total_input_tokens: z.number().int().nonnegative().default(0),
  total_output_tokens: z.number().int().nonnegative().default(0),
});

const approveSessionSchema = z.object({
  granted: z.literal(true),
});

const carbonFactorSchema = z.object({
  kg_co2e_per_kwh: z.string().regex(/^\d+(\.\d{1,3})?$/),
  source: z.string().trim().min(1).max(300),
  version: z.string().trim().min(1).max(100),
});

const carbonReportRequestSchema = z.object({
  drill_id: uuidSchema,
  emission_factor: carbonFactorSchema,
});

@Controller()
export class AgentController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly scope: OrgScopeService,
  ) {}

  @Post('facilities/:facilityId/agent/sessions')
  @HttpCode(201)
  async startSession(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Body(zodBody(startSessionSchema))
    request: z.infer<typeof startSessionSchema>,
  ) {
    const scopeRow = await this.scope.requireFacility(userId, facilityId, 'drill:plan');

    const [session] = await this.db
      .insert(schema.agentSessions)
      .values({
        organizationId: scopeRow.organizationId,
        facilityId,
        status: request.status,
        situation: request.situation,
        harnessVersion: 'gridflex-llm-harness-1.0.0', // PLANNER_HARNESS_VERSION (@gridflex/forecast)
        modelId: request.model_id,
        steps: request.steps,
        planFingerprint: request.plan_fingerprint,
        totalInputTokens: request.total_input_tokens,
        totalOutputTokens: request.total_output_tokens,
        startedBy: userId,
        finishedAt: request.status === 'RUNNING' ? null : new Date().toISOString(),
      })
      .returning();

    return { session: this.toSessionDto(session!) };
  }

  @Get('facilities/:facilityId/agent/sessions')
  async listSessions(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'drill:read');

    const sessions = await this.db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.facilityId, facilityId))
      .orderBy(desc(schema.agentSessions.startedAt))
      .limit(50);

    return { sessions: sessions.map((session) => this.toSessionDto(session)) };
  }

  @Get('agent/sessions/:sessionId')
  async getSession(
    @CurrentUserId() userId: string,
    @Param('sessionId', new ZodValidationPipe(uuidSchema)) sessionId: string,
  ) {
    const [session] = await this.db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, sessionId))
      .limit(1);

    if (!session) throw new DomainError('AGENT_SESSION_NOT_FOUND', 'Session not found', undefined, 404);
    await this.scope.requireFacility(userId, session.facilityId, 'drill:read');
    return { session: this.toSessionDto(session) };
  }

  /**
   * Books an operator approval on an awaiting session. The approval binds to
   * the plan fingerprint the harness stored — the same binding the
   * orchestrator enforces before any mutating tool runs.
   */
  @Post('agent/sessions/:sessionId/approve')
  @HttpCode(200)
  async approveSession(
    @CurrentUserId() userId: string,
    @Param('sessionId', new ZodValidationPipe(uuidSchema)) sessionId: string,
    @Body(zodBody(approveSessionSchema))
    _request: z.infer<typeof approveSessionSchema>,
  ) {
    const [session] = await this.db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, sessionId))
      .limit(1);

    if (!session) throw new DomainError('AGENT_SESSION_NOT_FOUND', 'Session not found', undefined, 404);
    await this.scope.requireFacility(userId, session.facilityId, 'drill:arm');

    if (session.status !== 'AWAITING_APPROVAL') {
      throw new DomainError(
        'AGENT_SESSION_NOT_AWAITING_APPROVAL',
        'Session is not awaiting operator approval',
        undefined,
        409,
      );
    }

    const [updated] = await this.db
      .update(schema.agentSessions)
      .set({ approvedBy: userId, approvedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, sessionId))
      .returning();

    return { session: this.toSessionDto(updated!) };
  }

  /**
   * Computes and seals the Scope 2 carbon report for a completed drill.
   * Reads the MRV figures from the drill's own report, applies the DECLARED
   * emission factor supplied in the request, and stores the sealed pair.
   */
  @Post('facilities/:facilityId/carbon-reports')
  @HttpCode(201)
  async createCarbonReport(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Body(zodBody(carbonReportRequestSchema))
    request: z.infer<typeof carbonReportRequestSchema>,
  ) {
    const scopeRow = await this.scope.requireFacility(userId, facilityId, 'passport:read');
    const organizationId = scopeRow.organizationId;

    const [drill] = await this.db
      .select()
      .from(schema.drills)
      .where(and(eq(schema.drills.id, request.drill_id), eq(schema.drills.facilityId, facilityId)))
      .limit(1);
    if (!drill) throw new DomainError('NOT_FOUND', 'Drill not found', undefined, 404);

    if (drill.status !== 'COMPLETED') {
      throw new DomainError(
        'DRILL_INVALID_TRANSITION',
        'Carbon MRV requires a completed, verified drill',
        undefined,
        409,
      );
    }

    const [mrv] = await this.db
      .select()
      .from(schema.mrvReports)
      .where(eq(schema.mrvReports.drillId, drill.id))
      .limit(1);
    if (!mrv) {
      throw new DomainError('MRV_NOT_GENERATED', 'No MRV report for this drill', undefined, 404);
    }

    const [evidence] = await this.db
      .select()
      .from(schema.evidenceBundles)
      .where(eq(schema.evidenceBundles.drillId, drill.id))
      .limit(1);

    const deliveredEnergyWh = BigInt(mrv.deliveredEnergyWh);
    // Counterfactual: what the baseline would have consumed over the window.
    const baselineSeries = mrv.baselineSeries as { value: string }[];
    const intervalSeconds = mrv.intervalSeconds;
    const baselineEnergyWh = baselineSeries.reduce((total, point) => {
      const kw = Number(point.value);
      return total + BigInt(Math.round((kw * intervalSeconds * 1000) / 60));
    }, 0n);

    const emissionFactor: GridEmissionFactor = {
      kgCo2ePerKwh: request.emission_factor.kg_co2e_per_kwh,
      source: request.emission_factor.source,
      version: request.emission_factor.version,
    };

    const report = computeCarbonReport({
      deliveredEnergyWh,
      baselineEnergyWh,
      emissionFactor,
      periodStart: toRfc3339(drill.plannedStartAt ?? drill.createdAt),
      periodEnd: toRfc3339(drill.plannedEndAt ?? drill.createdAt),
      facilityId,
      drillId: drill.id,
      evidenceSha256: evidence?.canonicalSha256 ?? 'unsealed',
    });

    const [inserted] = await this.db
      .insert(schema.carbonReports)
      .values({
        organizationId,
        facilityId,
        drillId: drill.id,
        methodologyVersion: CARBON_MRV_VERSION,
        reportJson: report,
        reportSha256: report.reportSha256,
        emissionFactorSource: emissionFactor.source,
        emissionFactorVersion: emissionFactor.version,
        avoidedTco2e: report.avoidedTco2e,
        baselineTco2e: report.baselineTco2e,
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted) {
      const [existing] = await this.db
        .select()
        .from(schema.carbonReports)
        .where(eq(schema.carbonReports.reportSha256, report.reportSha256))
        .limit(1);
      return { report: this.toCarbonDto(existing!), resealed: false };
    }

    return { report: this.toCarbonDto(inserted), resealed: false };
  }

  @Get('facilities/:facilityId/carbon-reports')
  async listCarbonReports(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'passport:read');

    const reports = await this.db
      .select()
      .from(schema.carbonReports)
      .where(eq(schema.carbonReports.facilityId, facilityId))
      .orderBy(desc(schema.carbonReports.createdAt))
      .limit(50);

    return { reports: reports.map((report) => this.toCarbonDto(report)) };
  }

  private toSessionDto(session: typeof schema.agentSessions.$inferSelect) {
    return {
      id: session.id,
      facility_id: session.facilityId,
      drill_id: session.drillId,
      status: session.status,
      situation: session.situation,
      harness_version: session.harnessVersion,
      model_id: session.modelId,
      steps: session.steps,
      plan_fingerprint: session.planFingerprint,
      approved_by: session.approvedBy,
      approved_at: session.approvedAt ? toRfc3339(session.approvedAt) : null,
      total_input_tokens: session.totalInputTokens,
      total_output_tokens: session.totalOutputTokens,
      started_by: session.startedBy,
      started_at: toRfc3339(session.startedAt),
      finished_at: session.finishedAt ? toRfc3339(session.finishedAt) : null,
    };
  }

  private toCarbonDto(report: typeof schema.carbonReports.$inferSelect) {
    return {
      id: report.id,
      facility_id: report.facilityId,
      drill_id: report.drillId,
      methodology_version: report.methodologyVersion,
      report: report.reportJson,
      report_sha256: report.reportSha256,
      emission_factor_source: report.emissionFactorSource,
      emission_factor_version: report.emissionFactorVersion,
      avoided_tco2e: report.avoidedTco2e,
      baseline_tco2e: report.baselineTco2e,
      created_at: toRfc3339(report.createdAt),
    };
  }
}

