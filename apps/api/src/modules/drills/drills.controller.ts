import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { schema } from '@gridflex/db/client';
import type { Database } from '@gridflex/db/client';
import {
  ARM_CHALLENGE_TTL_SECONDS,
  DomainError,
  abortDrillRequestSchema,
  armConfirmRequestSchema,
  clearEmergencyStopRequestSchema,
  createDrillRequestSchema,
  emergencyStopRequestSchema,
  uuidSchema,
  type AbortDrillRequest,
  type ArmConfirmRequest,
  type ClearEmergencyStopRequest,
  type CreateDrillRequest,
  type EmergencyStopRequest,
  type ErrorCode,
  type Permission,
} from '@gridflex/contracts';
import {
  CANONICAL_SCHEMA_VERSION,
  MRV_METHODOLOGY_VERSION,
  SIMULATOR_VERSION,
  checkPlanAgainstLimits,
  canonicalStringify,
  computeBaseline,
  computeMrv,
  energyWh,
  evaluateTransition,
  eventTypeForAction,
  kwStringToMilliKw,
  milliKwToKwString,
  sealDocument,
  simulateBaselineDays,
  simulateDrill,
  type DrillAction,
  type DrillPlan,
  type DrillStatus,
  type FacilityLimits,
  type SafetyContext,
  type TransitionRefusal,
} from '@gridflex/engine';
import { DATABASE } from '../../common/database/database.module.js';
import { CurrentUserId } from '../../common/auth/auth.guard.js';
import { OrgScopeService } from '../../common/auth/org-scope.service.js';
import {
  ZodValidationPipe,
  zodBody,
} from '../../common/pipes/zod-validation.pipe.js';
import { toRfc3339 } from '../facilities/facilities.controller.js';

const TELEMETRY_WINDOW_HOURS = 24;
const TELEMETRY_INTERVAL_SECONDS = 60;
// Two one-minute intervals plus 60 seconds (spec 10.2).
const TELEMETRY_STALE_AFTER_MS = 3 * 60 * 1000;
const LIVE_DRILL_STATUSES: (typeof schema.drills.$inferSelect.status)[] = [
  'ARMED',
  'RUNNING',
  'VERIFYING',
];

/**
 * Operational drill API (spec 9.4 and 13).
 *
 * Every state mutation:
 *  - locks the facility, which serializes the one-live-drill invariant;
 *  - is decided by the pure engine state machine;
 *  - writes an immutable drill event and audit record in the same transaction.
 *
 * The API never accepts an arbitrary status from a caller.
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
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'drill:read');

    const rows = await this.db
      .select()
      .from(schema.drills)
      .where(eq(schema.drills.facilityId, facilityId))
      .orderBy(desc(schema.drills.createdAt));

    return { drills: rows.map(toDrillDto) };
  }

  @Post('facilities/:facilityId/drills')
  @HttpCode(201)
  async create(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Body(zodBody(createDrillRequestSchema)) body: CreateDrillRequest,
  ) {
    const { organizationId } = await this.scope.requireFacility(
      userId,
      facilityId,
      'drill:plan',
    );

    return this.db.transaction(async (tx) => {
      await lockFacility(tx, facilityId);

      const [envelope] = body.envelope_id
        ? await tx
            .select()
            .from(schema.envelopes)
            .where(
              and(
                eq(schema.envelopes.id, body.envelope_id),
                eq(schema.envelopes.facilityId, facilityId),
              ),
            )
            .limit(1)
        : await tx
            .select()
            .from(schema.envelopes)
            .where(
              and(
                eq(schema.envelopes.facilityId, facilityId),
                eq(schema.envelopes.status, 'CURRENT'),
              ),
            )
            .orderBy(desc(schema.envelopes.version))
            .limit(1);

      if (body.envelope_id && !envelope) {
        throw new DomainError(
          'NOT_FOUND',
          'Envelope not found for this facility.',
          undefined,
          404,
        );
      }

      const derivedRamp = envelope
        ? Number(body.requested_reduction_kw) /
          Math.max(envelope.responseTimeSeconds / 60, 1 / 60)
        : null;
      const plannedRamp = body.planned_ramp_kw_per_min ??
        (derivedRamp === null ? null : formatPower(derivedRamp));

      const [drill] = await tx
        .insert(schema.drills)
        .values({
          organizationId,
          facilityId,
          envelopeId: envelope?.id ?? null,
          name: body.name,
          requestedReductionKw: body.requested_reduction_kw,
          plannedStartAt: body.planned_start_at,
          plannedEndAt: body.planned_end_at,
          maximumRampKwPerMin: plannedRamp,
          operatorNotes: body.operator_notes,
          simulationMode: body.simulation_mode,
          replayMode: false,
          createdBy: userId,
        })
        .returning();

      const created = drill!;
      const correlationId = randomUUID();
      const [event] = await tx
        .insert(schema.drillEvents)
        .values({
          drillId: created.id,
          eventType: 'CREATED',
          actorUserId: userId,
          reasonCode: 'OPERATOR_PLAN_CREATED',
          correlationId,
          payload: {
            simulation_mode: created.simulationMode,
            envelope_id: created.envelopeId,
          },
        })
        .returning();

      await tx.insert(schema.auditLogs).values({
        organizationId,
        facilityId,
        actorUserId: userId,
        action: 'DRILL_CREATED',
        objectType: 'drills',
        objectId: created.id,
        afterState: {
          status: created.status,
          simulation_mode: created.simulationMode,
          envelope_id: created.envelopeId,
        },
        requestId: correlationId,
      });

      return { drill: toDrillDto(created), event: toEventDto(event!) };
    });
  }

  @Get('drills/:drillId')
  async detail(
    @CurrentUserId() userId: string,
    @Param('drillId', new ZodValidationPipe(uuidSchema)) drillId: string,
  ) {
    const drill = await this.requireDrill(userId, drillId);

    const events = await this.db
      .select()
      .from(schema.drillEvents)
      .where(eq(schema.drillEvents.drillId, drillId))
      .orderBy(asc(schema.drillEvents.occurredAt), asc(schema.drillEvents.id));

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
      .orderBy(asc(schema.evidenceBundles.createdAt))
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

  @Post('drills/:drillId/validate')
  async validate(
    @CurrentUserId() userId: string,
    @Param('drillId', new ZodValidationPipe(uuidSchema)) drillId: string,
  ) {
    return this.transition(userId, drillId, 'drill:plan', 'VALIDATE', {
      reasonCode: 'PLAN_WITHIN_LIMITS',
    });
  }

  @Post('drills/:drillId/arm-intent')
  async armIntent(
    @CurrentUserId() userId: string,
    @Param('drillId', new ZodValidationPipe(uuidSchema)) drillId: string,
  ) {
    const visible = await this.requireDrill(userId, drillId, 'drill:arm');

    return this.db.transaction(async (tx) => {
      await lockFacility(tx, visible.facilityId);
      const drill = await loadDrillForUpdate(tx, drillId);
      const context = await this.operationContext(tx, drill);
      const result = evaluateTransition({
        currentStatus: drill.status as DrillStatus,
        action: 'ARM',
        safety: context.safety,
        plan: context.plan,
        limits: context.limits,
      });
      if (!result.allowed) throwTransitionRefusal(result.refusals);

      const challengeId = randomUUID();
      const confirmationPhrase = `ARM ${drill.name}`;
      const now = Date.now();
      const expiresAt = new Date(now + ARM_CHALLENGE_TTL_SECONDS * 1000).toISOString();
      const constraintSnapshot = {
        minimum_safe_load_kw: context.constraints.minimumSafeLoadKw,
        maximum_curtailment_kw: context.constraints.maximumCurtailmentKw,
        maximum_ramp_kw_per_min: context.constraints.maximumRampKwPerMin,
        maximum_duration_min: context.constraints.maximumDurationMin,
        thermal_limit_c: context.constraints.thermalLimitC,
      };
      const storedSnapshot = armingSnapshot(context, drill);

      await tx.insert(schema.drillArmChallenges).values({
        id: challengeId,
        drillId,
        requestedBy: userId,
        challengeHash: sha256(challengeId),
        expectedConfirmationHash: sha256(confirmationPhrase),
        constraintSnapshot: storedSnapshot,
        expiresAt,
      });

      await tx.insert(schema.auditLogs).values({
        organizationId: drill.organizationId,
        facilityId: drill.facilityId,
        actorUserId: userId,
        action: 'DRILL_ARM_INTENT_CREATED',
        objectType: 'drill_arm_challenges',
        objectId: challengeId,
        afterState: { drill_id: drill.id, expires_at: expiresAt },
      });

      const durationMin = context.plan.durationMin;
      const warnings: { code: string; message: string }[] = [];
      if (drill.simulationMode) {
        warnings.push({
          code: 'SIMULATION_MODE',
          message: 'This drill uses simulated execution and will be labelled as simulated.',
        });
      }
      if (context.safety.telemetryCompleteness < 0.95) {
        warnings.push({
          code: 'BELOW_PRODUCTION_QUALITY_TARGET',
          message: 'Telemetry passes the pilot threshold but is below the 95% production target.',
        });
      }

      return {
        challenge_id: challengeId,
        expires_at: toRfc3339(expiresAt),
        confirmation_phrase: confirmationPhrase,
        constraint_snapshot: constraintSnapshot,
        expected_effects: {
          target_load_kw: formatPower(
            Number(context.facility.normalLoadKw) - Number(drill.requestedReductionKw),
          ),
          reduction_kw: drill.requestedReductionKw,
          duration_min: durationMin,
          estimated_energy_kwh: (
            (Number(drill.requestedReductionKw) * durationMin) /
            60
          ).toFixed(3),
          ramp_duration_min: (
            Number(drill.requestedReductionKw) / context.plan.rampKwPerMin
          ).toFixed(3),
        },
        warnings,
      };
    });
  }

  @Post('drills/:drillId/arm-confirm')
  async armConfirm(
    @CurrentUserId() userId: string,
    @Param('drillId', new ZodValidationPipe(uuidSchema)) drillId: string,
    @Body(zodBody(armConfirmRequestSchema)) body: ArmConfirmRequest,
  ) {
    const visible = await this.requireDrill(userId, drillId, 'drill:arm');

    return this.db.transaction(async (tx) => {
      await lockFacility(tx, visible.facilityId);
      const drill = await loadDrillForUpdate(tx, drillId);

      const [challenge] = await tx
        .select()
        .from(schema.drillArmChallenges)
        .where(
          and(
            eq(schema.drillArmChallenges.id, body.challenge_id),
            eq(schema.drillArmChallenges.drillId, drillId),
          ),
        )
        .limit(1);

      if (!challenge || challenge.requestedBy !== userId) {
        throw new DomainError(
          'ARM_CONFIRMATION_MISMATCH',
          'The arming challenge does not match this drill and operator.',
          undefined,
          409,
        );
      }
      if (challenge.consumedAt) {
        throw new DomainError(
          'ARM_CHALLENGE_CONSUMED',
          'This arming challenge has already been used.',
          undefined,
          409,
        );
      }
      if (Date.parse(challenge.expiresAt) <= Date.now()) {
        throw new DomainError(
          'ARM_CHALLENGE_EXPIRED',
          'This arming challenge has expired. Request a new one.',
          undefined,
          409,
        );
      }
      if (
        !constantTimeEqual(challenge.challengeHash, sha256(challenge.id)) ||
        !constantTimeEqual(
          challenge.expectedConfirmationHash,
          sha256(body.confirmation_phrase),
        )
      ) {
        throw new DomainError(
          'ARM_CONFIRMATION_MISMATCH',
          'The typed confirmation phrase does not match.',
          undefined,
          409,
        );
      }

      const context = await this.operationContext(tx, drill);
      if (
        canonicalStringify(challenge.constraintSnapshot as import('@gridflex/engine').CanonicalInput) !==
        canonicalStringify(armingSnapshot(context, drill))
      ) {
        throw new DomainError(
          'ARM_CONFIRMATION_MISMATCH',
          'The facility limits, envelope, or drill plan changed after review. Request a new arming challenge.',
          undefined,
          409,
        );
      }
      const applied = await this.applyTransition(tx, userId, drill, 'ARM', context, {
        reasonCode: 'TWO_STEP_CONFIRMED',
        payload: { challenge_id: challenge.id },
      });

      const [consumed] = await tx
        .update(schema.drillArmChallenges)
        .set({ consumedAt: applied.occurred_at })
        .where(
          and(
            eq(schema.drillArmChallenges.id, challenge.id),
            isNull(schema.drillArmChallenges.consumedAt),
          ),
        )
        .returning({ id: schema.drillArmChallenges.id });
      if (!consumed) {
        throw new DomainError(
          'ARM_CHALLENGE_CONSUMED',
          'This arming challenge has already been used.',
          undefined,
          409,
        );
      }

      return applied;
    });
  }

  @Post('drills/:drillId/start')
  async start(
    @CurrentUserId() userId: string,
    @Param('drillId', new ZodValidationPipe(uuidSchema)) drillId: string,
  ) {
    return this.transition(userId, drillId, 'drill:arm', 'START', {
      reasonCode: 'OPERATOR_STARTED',
    });
  }

  /** Normal execution stop: the drill enters VERIFYING, never COMPLETED. */
  @Post('drills/:drillId/stop')
  async stop(
    @CurrentUserId() userId: string,
    @Param('drillId', new ZodValidationPipe(uuidSchema)) drillId: string,
  ) {
    return this.transition(userId, drillId, 'drill:arm', 'COMPLETE', {
      reasonCode: 'EXECUTION_STOPPED_FOR_VERIFICATION',
    });
  }

  /** Spec-compatible alias for clients that use `/complete`. */
  @Post('drills/:drillId/complete')
  async complete(
    @CurrentUserId() userId: string,
    @Param('drillId', new ZodValidationPipe(uuidSchema)) drillId: string,
  ) {
    return this.transition(userId, drillId, 'drill:arm', 'COMPLETE', {
      reasonCode: 'EXECUTION_STOPPED_FOR_VERIFICATION',
    });
  }

  @Post('drills/:drillId/verify')
  async verify(
    @CurrentUserId() userId: string,
    @Param('drillId', new ZodValidationPipe(uuidSchema)) drillId: string,
  ) {
    return this.transition(userId, drillId, 'drill:plan', 'VERIFY', {
      reasonCode: 'MRV_AND_EVIDENCE_VERIFIED',
      requireEvidence: true,
    });
  }

  @Post('drills/:drillId/abort')
  async abort(
    @CurrentUserId() userId: string,
    @Param('drillId', new ZodValidationPipe(uuidSchema)) drillId: string,
    @Body(zodBody(abortDrillRequestSchema)) body: AbortDrillRequest,
  ) {
    return this.transition(userId, drillId, 'drill:arm', 'ABORT', {
      reasonCode: body.reason_code,
      ...(body.reason_detail ? { reasonDetail: body.reason_detail } : {}),
    });
  }

  @Post('drills/:drillId/emergency-stop')
  async emergencyStop(
    @CurrentUserId() userId: string,
    @Param('drillId', new ZodValidationPipe(uuidSchema)) drillId: string,
    @Body(zodBody(emergencyStopRequestSchema)) body: EmergencyStopRequest,
  ) {
    const visible = await this.requireDrill(userId, drillId, 'drill:emergency_stop');

    return this.db.transaction(async (tx) => {
      await lockFacility(tx, visible.facilityId);
      const drill = await loadDrillForUpdate(tx, drillId);
      const context = await this.operationContext(tx, drill);

      const result = evaluateTransition({
        currentStatus: drill.status as DrillStatus,
        action: 'ABORT',
        safety: { ...context.safety, emergencyStopActive: true },
      });
      if (!result.allowed) throwTransitionRefusal(result.refusals);

      const [alreadyActive] = await tx
        .select()
        .from(schema.emergencyStopEvents)
        .where(
          and(
            eq(schema.emergencyStopEvents.facilityId, drill.facilityId),
            isNull(schema.emergencyStopEvents.clearedAt),
          ),
        )
        .orderBy(desc(schema.emergencyStopEvents.activatedAt))
        .limit(1);
      const stopEvent = alreadyActive ??
        (
          await tx
            .insert(schema.emergencyStopEvents)
            .values({
              facilityId: drill.facilityId,
              drillId,
              activatedBy: userId,
              reasonCode: body.reason_code,
              reasonDetail: body.reason_detail,
            })
            .returning()
        )[0]!;

      const correlationId = randomUUID();
      await tx.insert(schema.drillEvents).values({
        drillId,
        eventType: 'EMERGENCY_STOP',
        actorUserId: userId,
        reasonCode: body.reason_code,
        correlationId,
        payload: {
          emergency_stop_id: stopEvent.id,
          already_active: alreadyActive !== undefined,
          reason_detail: body.reason_detail ?? null,
        },
      });

      const applied = await this.applyTransition(tx, userId, drill, 'ABORT', context, {
        reasonCode: body.reason_code,
        ...(body.reason_detail ? { reasonDetail: body.reason_detail } : {}),
        auditAction: 'DRILL_EMERGENCY_STOPPED',
        payload: {
          emergency_stop_id: stopEvent.id,
          already_active: alreadyActive !== undefined,
        },
      });

      return { emergency_stop_id: stopEvent.id, ...applied };
    });
  }

  @Post('facilities/:facilityId/emergency-stop/clear')
  async clearEmergencyStop(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Body(zodBody(clearEmergencyStopRequestSchema)) body: ClearEmergencyStopRequest,
  ) {
    const { organizationId } = await this.scope.requireFacility(
      userId,
      facilityId,
      'drill:emergency_stop',
    );

    return this.db.transaction(async (tx) => {
      await lockFacility(tx, facilityId);
      const [active] = await tx
        .select()
        .from(schema.emergencyStopEvents)
        .where(
          and(
            eq(schema.emergencyStopEvents.facilityId, facilityId),
            isNull(schema.emergencyStopEvents.clearedAt),
          ),
        )
        .orderBy(desc(schema.emergencyStopEvents.activatedAt))
        .limit(1);

      if (!active) return { cleared: false, emergency_stop_id: null };
      const clearedAt = new Date().toISOString();
      await tx
        .update(schema.emergencyStopEvents)
        .set({ clearedBy: userId, clearedAt, clearNote: body.clear_note })
        .where(eq(schema.emergencyStopEvents.id, active.id));
      await tx.insert(schema.auditLogs).values({
        organizationId,
        facilityId,
        actorUserId: userId,
        action: 'EMERGENCY_STOP_CLEARED',
        objectType: 'emergency_stop_events',
        objectId: active.id,
        beforeState: { active: true },
        afterState: { active: false, cleared_at: clearedAt },
      });
      return {
        cleared: true,
        emergency_stop_id: active.id,
        cleared_at: toRfc3339(clearedAt),
      };
    });
  }

  @Get('drills/:drillId/events')
  async events(
    @CurrentUserId() userId: string,
    @Param('drillId', new ZodValidationPipe(uuidSchema)) drillId: string,
  ) {
    await this.requireDrill(userId, drillId);
    const rows = await this.db
      .select()
      .from(schema.drillEvents)
      .where(eq(schema.drillEvents.drillId, drillId))
      .orderBy(asc(schema.drillEvents.occurredAt), asc(schema.drillEvents.id));
    return { events: rows.map(toEventDto) };
  }

  @Get('drills/:drillId/mrv')
  async mrv(
    @CurrentUserId() userId: string,
    @Param('drillId', new ZodValidationPipe(uuidSchema)) drillId: string,
  ) {
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

  private async transition(
    userId: string,
    drillId: string,
    permission: Permission,
    action: DrillAction,
    options: TransitionOptions,
  ) {
    const visible = await this.requireDrill(userId, drillId, permission);

    return this.db.transaction(async (tx) => {
      await lockFacility(tx, visible.facilityId);
      const drill = await loadDrillForUpdate(tx, drillId);
      const context = await this.operationContext(tx, drill);
      return this.applyTransition(tx, userId, drill, action, context, options);
    });
  }

  private async applyTransition(
    tx: Database,
    userId: string,
    drill: typeof schema.drills.$inferSelect,
    action: DrillAction,
    context: OperationContext,
    options: TransitionOptions,
  ) {
    if (action === 'VALIDATE') {
      const planRefusals = checkPlanAgainstLimits(context.plan, context.limits);
      if (!context.safety.envelopeCurrent) {
        planRefusals.unshift({
          code: 'ENVELOPE_NOT_CURRENT',
          message: 'A current envelope is required before validating this drill.',
        });
      }
      if (planRefusals.length > 0) throwTransitionRefusal(planRefusals);
    }

    const result = evaluateTransition({
      currentStatus: drill.status as DrillStatus,
      action,
      safety: context.safety,
      plan: context.plan,
      limits: context.limits,
    });
    if (!result.allowed) throwTransitionRefusal(result.refusals);
    if (options.requireEvidence) {
      await requireValidDrillEvidence(tx, drill.id);
    }

    const occurredAt = new Date().toISOString();
    const nextStatus = result.nextStatus;
    const update: Partial<typeof schema.drills.$inferInsert> = {
      status: nextStatus,
      updatedAt: occurredAt,
    };
    if (action === 'VALIDATE' && !drill.envelopeId && context.envelope) {
      update.envelopeId = context.envelope.id;
    }
    if (action === 'ARM') {
      update.armedBy = userId;
      update.armedAt = occurredAt;
    }
    if (action === 'START') update.startedAt = occurredAt;
    if (action === 'COMPLETE' || action === 'ABORT') update.endedAt = occurredAt;
    if (action === 'ABORT') {
      update.abortReasonCode = options.reasonCode;
      update.abortReasonDetail = options.reasonDetail ?? null;
    }

    await tx.update(schema.drills).set(update).where(eq(schema.drills.id, drill.id));

    const correlationId = randomUUID();
    const [event] = await tx
      .insert(schema.drillEvents)
      .values({
        drillId: drill.id,
        eventType: eventTypeForAction(action) as typeof schema.drillEvents.$inferInsert.eventType,
        occurredAt,
        actorUserId: userId,
        reasonCode: options.reasonCode,
        correlationId,
        payload: {
          previous_status: drill.status,
          next_status: nextStatus,
          simulation_mode: drill.simulationMode,
          reason_detail: options.reasonDetail ?? null,
          ...(options.payload ?? {}),
        },
      })
      .returning();

    await tx.insert(schema.auditLogs).values({
      organizationId: drill.organizationId,
      facilityId: drill.facilityId,
      actorUserId: userId,
      action: options.auditAction ?? auditActionFor(action),
      objectType: 'drills',
      objectId: drill.id,
      beforeState: { status: drill.status },
      afterState: { status: nextStatus },
      requestId: correlationId,
    });

    // Pilot simulation runs on an explicit virtual clock. Stopping execution
    // deterministically produces the labelled telemetry, MRV, evidence bundle,
    // MRV_GENERATED event, and audit row in this same transaction. A physical
    // drill can never take this path (V1's request contract only permits true).
    if (action === 'COMPLETE' && drill.simulationMode) {
      await generateSimulationEvidence(tx, drill, context, occurredAt, userId);
    }

    return {
      drill_id: drill.id,
      previous_status: drill.status,
      status: nextStatus,
      event_id: String(event!.id),
      occurred_at: toRfc3339(occurredAt),
    };
  }

  private async operationContext(
    tx: Database,
    drill: typeof schema.drills.$inferSelect,
  ): Promise<OperationContext> {
    const [facility] = await tx
      .select()
      .from(schema.facilities)
      .where(eq(schema.facilities.id, drill.facilityId))
      .limit(1);
    if (!facility) throw new DomainError('NOT_FOUND', 'Facility not found.', undefined, 404);
    if (facility.normalLoadKw === null) {
      throw new DomainError(
        'CONSTRAINTS_MISSING',
        'Facility normal load is required for a safe drill plan.',
        undefined,
        409,
      );
    }

    const now = new Date().toISOString();
    const [constraints] = await tx
      .select()
      .from(schema.facilityConstraints)
      .where(
        and(
          eq(schema.facilityConstraints.facilityId, drill.facilityId),
          lte(schema.facilityConstraints.effectiveFrom, now),
          or(
            isNull(schema.facilityConstraints.effectiveTo),
            gt(schema.facilityConstraints.effectiveTo, now),
          ),
        ),
      )
      .orderBy(desc(schema.facilityConstraints.version))
      .limit(1);
    if (!constraints) {
      throw new DomainError(
        'CONSTRAINTS_MISSING',
        'Active facility safety constraints are required for a drill.',
        undefined,
        409,
      );
    }

    const [envelope] = drill.envelopeId
      ? await tx
          .select()
          .from(schema.envelopes)
          .where(
            and(
              eq(schema.envelopes.id, drill.envelopeId),
              eq(schema.envelopes.facilityId, drill.facilityId),
            ),
          )
          .limit(1)
      : await tx
          .select()
          .from(schema.envelopes)
          .where(
            and(
              eq(schema.envelopes.facilityId, drill.facilityId),
              eq(schema.envelopes.status, 'CURRENT'),
            ),
          )
          .orderBy(desc(schema.envelopes.version))
          .limit(1);

    const durationMin = Math.ceil(
      (Date.parse(drill.plannedEndAt) - Date.parse(drill.plannedStartAt)) / 60_000,
    );
    const rampKwPerMin = drill.maximumRampKwPerMin === null
      ? Number(drill.requestedReductionKw) /
        Math.max((envelope?.responseTimeSeconds ?? 60) / 60, 1 / 60)
      : Number(drill.maximumRampKwPerMin);
    const plan: DrillPlan = {
      requestedReductionKw: Number(drill.requestedReductionKw),
      durationMin,
      rampKwPerMin,
    };
    const limits: FacilityLimits = {
      normalLoadKw: Number(facility.normalLoadKw),
      minimumSafeLoadKw: Number(constraints.minimumSafeLoadKw),
      maximumCurtailmentKw: Number(constraints.maximumCurtailmentKw),
      maximumRampKwPerMin: Number(constraints.maximumRampKwPerMin),
      maximumDurationMin: constraints.maximumDurationMin,
      envelopeReducibleKw: envelope ? Number(envelope.totalReducibleKw) : null,
    };

    const telemetryStart = new Date(
      Date.now() - TELEMETRY_WINDOW_HOURS * 60 * 60 * 1000,
    ).toISOString();
    const telemetryEnd = new Date().toISOString();
    const [quality] = await tx
      .select({
        count: sql<string>`count(distinct date_trunc('minute', ${schema.telemetryReadings.measuredAt}))::text`,
        lastReadingAt: sql<string | null>`max(${schema.telemetryReadings.measuredAt})`,
      })
      .from(schema.telemetryReadings)
      .where(
        and(
          eq(schema.telemetryReadings.facilityId, drill.facilityId),
          eq(schema.telemetryReadings.metricKey, 'facility.active_power_kw'),
          inArray(schema.telemetryReadings.quality, ['GOOD', 'ESTIMATED']),
          sql`${schema.telemetryReadings.measuredAt} >= ${telemetryStart}`,
          lte(schema.telemetryReadings.measuredAt, telemetryEnd),
        ),
      );
    const expected = (TELEMETRY_WINDOW_HOURS * 3600) / TELEMETRY_INTERVAL_SECONDS;
    const completeness = Math.min(1, Number(quality?.count ?? '0') / expected);
    const lastReadingAt = quality?.lastReadingAt ?? null;

    const [otherLive] = await tx
      .select({ id: schema.drills.id })
      .from(schema.drills)
      .where(
        and(
          eq(schema.drills.facilityId, drill.facilityId),
          ne(schema.drills.id, drill.id),
          inArray(schema.drills.status, LIVE_DRILL_STATUSES),
        ),
      )
      .limit(1);
    const [activeStop] = await tx
      .select({ id: schema.emergencyStopEvents.id })
      .from(schema.emergencyStopEvents)
      .where(
        and(
          eq(schema.emergencyStopEvents.facilityId, drill.facilityId),
          isNull(schema.emergencyStopEvents.clearedAt),
        ),
      )
      .limit(1);

    let thermalLimitExceeded = false;
    if (constraints.thermalLimitC !== null) {
      const [thermal] = await tx
        .select({
          value: schema.telemetryReadings.valueDouble,
          quality: schema.telemetryReadings.quality,
        })
        .from(schema.telemetryReadings)
        .where(
          and(
            eq(schema.telemetryReadings.facilityId, drill.facilityId),
            eq(schema.telemetryReadings.metricKey, 'thermal.max_inlet_c'),
          ),
        )
        .orderBy(desc(schema.telemetryReadings.measuredAt))
        .limit(1);
      thermalLimitExceeded =
        thermal !== undefined &&
        (thermal.quality !== 'GOOD' && thermal.quality !== 'ESTIMATED' ||
          thermal.value >= Number(constraints.thermalLimitC));
    }

    const safety: SafetyContext = {
      emergencyStopActive: activeStop !== undefined,
      anotherDrillLive: otherLive !== undefined,
      telemetryStale:
        lastReadingAt === null ||
        Date.now() - Date.parse(lastReadingAt) > TELEMETRY_STALE_AFTER_MS,
      telemetryCompleteness: completeness,
      thermalLimitExceeded,
      envelopeCurrent:
        envelope?.status === 'CURRENT' &&
        envelope.constraintsVersion === constraints.version &&
        (envelope.validUntil === null || Date.parse(envelope.validUntil) > Date.now()),
    };

    return { facility, constraints, envelope: envelope ?? null, plan, limits, safety };
  }

  private async requireDrill(
    userId: string,
    drillId: string,
    permission: Permission = 'drill:read',
  ) {
    const [drill] = await this.db
      .select()
      .from(schema.drills)
      .where(eq(schema.drills.id, drillId))
      .limit(1);

    if (!drill) throw new DomainError('NOT_FOUND', 'Drill not found', undefined, 404);
    await this.scope.requireFacility(userId, drill.facilityId, permission);
    return drill;
  }
}

interface TransitionOptions {
  readonly reasonCode: string;
  readonly reasonDetail?: string;
  readonly payload?: Record<string, unknown>;
  readonly auditAction?: string;
  readonly requireEvidence?: boolean;
}

interface OperationContext {
  readonly facility: typeof schema.facilities.$inferSelect;
  readonly constraints: typeof schema.facilityConstraints.$inferSelect;
  readonly envelope: typeof schema.envelopes.$inferSelect | null;
  readonly plan: DrillPlan;
  readonly limits: FacilityLimits;
  readonly safety: SafetyContext;
}

function armingSnapshot(
  context: OperationContext,
  drill: typeof schema.drills.$inferSelect,
): import('@gridflex/engine').CanonicalInput {
  return {
    minimum_safe_load_kw: context.constraints.minimumSafeLoadKw,
    maximum_curtailment_kw: context.constraints.maximumCurtailmentKw,
    maximum_ramp_kw_per_min: context.constraints.maximumRampKwPerMin,
    maximum_duration_min: context.constraints.maximumDurationMin,
    thermal_limit_c: context.constraints.thermalLimitC,
    facility_normal_load_kw: context.facility.normalLoadKw,
    envelope_id: context.envelope?.id ?? null,
    envelope_version: context.envelope?.version ?? null,
    envelope_total_reducible_kw: context.envelope?.totalReducibleKw ?? null,
    requested_reduction_kw: drill.requestedReductionKw,
    planned_duration_min: context.plan.durationMin,
    planned_ramp_kw_per_min: formatPower(context.plan.rampKwPerMin),
    simulation_mode: drill.simulationMode,
  };
}

async function lockFacility(tx: Database, facilityId: string): Promise<void> {
  const locked = await tx.execute(
    sql`select id from facilities where id = ${facilityId} for update`,
  );
  if (locked.rowCount === 0) {
    throw new DomainError('NOT_FOUND', 'Facility not found.', undefined, 404);
  }
}

async function loadDrillForUpdate(
  tx: Database,
  drillId: string,
): Promise<typeof schema.drills.$inferSelect> {
  await tx.execute(sql`select id from drills where id = ${drillId} for update`);
  const [drill] = await tx
    .select()
    .from(schema.drills)
    .where(eq(schema.drills.id, drillId))
    .limit(1);
  if (!drill) throw new DomainError('NOT_FOUND', 'Drill not found.', undefined, 404);
  return drill;
}

async function generateSimulationEvidence(
  tx: Database,
  drill: typeof schema.drills.$inferSelect,
  context: OperationContext,
  stoppedAt: string,
  actorUserId: string,
): Promise<void> {
  const [existing] = await tx
    .select({ id: schema.mrvReports.id })
    .from(schema.mrvReports)
    .where(eq(schema.mrvReports.drillId, drill.id))
    .limit(1);
  if (existing) {
    await requireValidDrillEvidence(tx, drill.id);
    return;
  }

  const intervalSeconds = 60;
  const durationMin = context.plan.durationMin;
  const seed = Number.parseInt(sha256(drill.id).slice(0, 8), 16);
  const simulation = simulateDrill({
    seed,
    normalLoadKw: context.limits.normalLoadKw,
    requestedReductionKw: context.plan.requestedReductionKw,
    sustainMinutes: durationMin,
    intervalSeconds,
  });
  const intervalCount = simulation.sustain.length;
  const baseline = computeBaseline({
    eligibleDays: simulateBaselineDays({
      seed,
      dayCount: 5,
      intervalCount,
      normalLoadKw: context.limits.normalLoadKw,
    }),
    precedingNonEventSamples: [],
    intervalCount,
  });
  const committedEnergyWh = energyWh(
    kwStringToMilliKw(drill.requestedReductionKw),
    durationMin * 60,
  );
  const mrv = computeMrv({
    baseline,
    actual: simulation.sustain.map((interval) => ({
      measuredAt: interval.measuredAt,
      power: interval.facilityPowerKw,
    })),
    intervalSeconds,
    committedEnergyWh,
  });

  // Simulation runs are intentionally accelerated. Their telemetry is placed on
  // a virtual event clock ending at the operator's stop action and is labelled
  // in both row metadata and every downstream Passport.
  const virtualStartMs = Date.parse(stoppedAt) - intervalCount * intervalSeconds * 1_000;
  const measuredAt = (index: number) =>
    new Date(virtualStartMs + index * intervalSeconds * 1_000).toISOString();
  const [connector] = await tx
    .select({ id: schema.connectors.id })
    .from(schema.connectors)
    .where(
      and(
        eq(schema.connectors.facilityId, drill.facilityId),
        eq(schema.connectors.connectorType, 'SIMULATOR'),
      ),
    )
    .orderBy(asc(schema.connectors.createdAt))
    .limit(1);

  const readings = simulation.sustain.flatMap((interval, index) =>
    interval.facilityPowerKw === null
      ? []
      : [
          {
            organizationId: drill.organizationId,
            facilityId: drill.facilityId,
            connectorId: connector?.id ?? null,
            sourceKey: `drill-simulator:${drill.id}`,
            metricKey: 'facility.active_power_kw',
            measuredAt: measuredAt(index),
            valueDouble: Number(milliKwToKwString(interval.facilityPowerKw)),
            unit: 'kW',
            quality: 'GOOD' as const,
            sourceSequence: String(index),
            metadata: {
              simulated: true,
              virtual_clock: true,
              drill_id: drill.id,
              simulator_version: SIMULATOR_VERSION,
              seed,
            },
          },
        ],
  );
  if (readings.length > 0) await tx.insert(schema.telemetryReadings).values(readings);

  const baselineSeries = mrv.baselineSeries.map((value, index) => ({
    measured_at: toRfc3339(measuredAt(index)),
    value: milliKwToKwString(value),
  }));
  const actualSeries = mrv.actualSeries.map((value, index) => ({
    measured_at: toRfc3339(measuredAt(index)),
    value: value === null ? null : milliKwToKwString(value),
  }));
  const [report] = await tx
    .insert(schema.mrvReports)
    .values({
      drillId: drill.id,
      methodologyVersion: MRV_METHODOLOGY_VERSION,
      intervalSeconds,
      committedEnergyWh: mrv.committedEnergyWh,
      deliveredEnergyWh: mrv.deliveredEnergyWh,
      averageDeliveredKw: mrv.averageDeliveredKw,
      performanceBps: mrv.performanceBps,
      telemetryCompleteness: mrv.telemetryCompleteness.toFixed(4),
      maximumGapIntervals: mrv.maximumGapIntervals,
      baselineSeries,
      actualSeries,
      qualityBlocks: [...mrv.qualityBlocks],
      reboundEnergyWh: mrv.reboundEnergyWh,
      generatedAt: stoppedAt,
    })
    .returning();

  const evidenceDocument: import('@gridflex/engine').CanonicalInput = {
    schema_version: CANONICAL_SCHEMA_VERSION,
    generated_at: stoppedAt,
    facility_id: drill.facilityId,
    drill_id: drill.id,
    simulation: {
      simulated: true,
      virtual_clock: true,
      simulator_version: SIMULATOR_VERSION,
      seed,
    },
    plan: {
      requested_reduction_kw: drill.requestedReductionKw,
      duration_min: durationMin,
      planned_ramp_kw_per_min: formatPower(context.plan.rampKwPerMin),
      minimum_safe_load_kw: context.constraints.minimumSafeLoadKw,
      maximum_curtailment_kw: context.constraints.maximumCurtailmentKw,
    },
    mrv: {
      report_id: report!.id,
      methodology_version: mrv.methodologyVersion,
      baseline_method: mrv.baselineMethod,
      interval_seconds: mrv.intervalSeconds,
      committed_energy_wh: mrv.committedEnergyWh,
      delivered_energy_wh: mrv.deliveredEnergyWh,
      average_delivered_kw: mrv.averageDeliveredKw,
      performance_bps: mrv.performanceBps,
      telemetry_completeness: mrv.telemetryCompleteness.toFixed(4),
      maximum_gap_intervals: mrv.maximumGapIntervals,
      eligible_days_used: [...mrv.eligibleDaysUsed],
      excluded_interval_indexes: [...mrv.excludedIntervalIndexes],
      baseline_series: baselineSeries,
      actual_series: actualSeries,
      quality_blocks: mrv.qualityBlocks.map((block) => ({
        code: block.code,
        interval_index: block.intervalIndex,
        detail: block.detail,
      })),
    },
  };
  const sealed = sealDocument(evidenceDocument);
  const [evidence] = await tx
    .insert(schema.evidenceBundles)
    .values({
      organizationId: drill.organizationId,
      facilityId: drill.facilityId,
      drillId: drill.id,
      mrvReportId: report!.id,
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      canonicalJson: sealed.canonicalJson,
      canonicalSha256: sealed.sha256,
    })
    .returning();

  const correlationId = randomUUID();
  await tx.insert(schema.drillEvents).values({
    drillId: drill.id,
    eventType: 'MRV_GENERATED',
    occurredAt: stoppedAt,
    actorService: 'gridflex-simulator',
    reasonCode: 'SIMULATED_MRV_COMPLETE',
    correlationId,
    payload: {
      simulated: true,
      virtual_clock: true,
      mrv_report_id: report!.id,
      evidence_bundle_id: evidence!.id,
      evidence_sha256: evidence!.canonicalSha256,
      performance_bps: mrv.performanceBps,
    },
  });
  await tx.insert(schema.auditLogs).values({
    organizationId: drill.organizationId,
    facilityId: drill.facilityId,
    actorUserId,
    actorService: 'gridflex-simulator',
    action: 'DRILL_SIMULATION_EVIDENCE_GENERATED',
    objectType: 'evidence_bundles',
    objectId: evidence!.id,
    afterState: {
      drill_id: drill.id,
      simulated: true,
      mrv_report_id: report!.id,
      evidence_sha256: evidence!.canonicalSha256,
    },
    requestId: correlationId,
  });
}

async function requireValidDrillEvidence(tx: Database, drillId: string): Promise<void> {
  const [mrv] = await tx
    .select()
    .from(schema.mrvReports)
    .where(eq(schema.mrvReports.drillId, drillId))
    .limit(1);
  if (!mrv) {
    throw new DomainError(
      'MRV_NOT_GENERATED',
      'The drill cannot be verified until its MRV report is generated.',
      undefined,
      409,
    );
  }
  if (Number(mrv.telemetryCompleteness) < 0.9 || mrv.maximumGapIntervals > 2) {
    throw new DomainError(
      'MRV_INSUFFICIENT_DATA',
      'The MRV report does not meet the drill certification quality threshold.',
      {
        telemetry_completeness: mrv.telemetryCompleteness,
        maximum_gap_intervals: mrv.maximumGapIntervals,
        required_completeness: '0.9000',
        maximum_allowed_gap_intervals: 2,
      },
      409,
    );
  }

  const [evidence] = await tx
    .select()
    .from(schema.evidenceBundles)
    .where(
      and(
        eq(schema.evidenceBundles.drillId, drillId),
        eq(schema.evidenceBundles.mrvReportId, mrv.id),
      ),
    )
    .orderBy(asc(schema.evidenceBundles.createdAt))
    .limit(1);
  if (!evidence) {
    throw new DomainError(
      'PASSPORT_BLOCKED',
      'The drill cannot be verified until an evidence bundle is generated.',
      undefined,
      409,
    );
  }

  const { verifyDocument } = await import('@gridflex/engine');
  const verification = verifyDocument(
    evidence.canonicalJson as Parameters<typeof verifyDocument>[0],
    evidence.canonicalSha256,
  );
  if (!verification.valid) {
    throw new DomainError(
      'EVIDENCE_HASH_MISMATCH',
      'Stored drill evidence does not match its canonical hash.',
      { evidence_bundle_id: evidence.id },
      409,
    );
  }
}

function throwTransitionRefusal(refusals: readonly TransitionRefusal[]): never {
  const first = refusals[0] ?? {
    code: 'DRILL_INVALID_TRANSITION',
    message: 'The requested drill transition is not allowed.',
  };
  throw new DomainError(first.code as ErrorCode, first.message, {
    blockers: refusals.map((refusal) => ({
      code: refusal.code,
      message: refusal.message,
      ...(refusal.details ? { details: refusal.details } : {}),
    })),
  }, 409);
}

function auditActionFor(action: DrillAction): string {
  switch (action) {
    case 'VALIDATE':
      return 'DRILL_VALIDATED';
    case 'ARM':
      return 'DRILL_ARMED';
    case 'START':
      return 'DRILL_STARTED';
    case 'COMPLETE':
      return 'DRILL_EXECUTION_COMPLETED';
    case 'VERIFY':
      return 'DRILL_EVIDENCE_VERIFIED';
    case 'ABORT':
      return 'DRILL_ABORTED';
    case 'CANCEL':
      return 'DRILL_CANCELLED';
    case 'FAIL':
      return 'DRILL_FAILED';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function formatPower(value: number): string {
  return value.toFixed(3).replace(/\.?0+$/, '');
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
    planned_ramp_kw_per_min: row.maximumRampKwPerMin,
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
