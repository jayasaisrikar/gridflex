/**
 * Drill state machine and safety invariants (spec §13).
 *
 * Pure and side-effect-free: it decides whether a transition is permitted and
 * why. Persistence, row locks, and event writes are the API's job — but no code
 * path anywhere may set a drill status without going through `evaluateTransition`.
 *
 * Spec §13: "No endpoint may directly set arbitrary status."
 */

export type DrillStatus =
  | 'DRAFT'
  | 'READY'
  | 'ARMED'
  | 'RUNNING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'ABORTED'
  | 'CANCELLED';

export type DrillAction =
  | 'VALIDATE'
  | 'ARM'
  | 'START'
  | 'COMPLETE'
  | 'VERIFY'
  | 'ABORT'
  | 'CANCEL'
  | 'FAIL';

/**
 * Allowed transitions (spec §13):
 *
 *   DRAFT -> READY -> ARMED -> RUNNING -> VERIFYING -> COMPLETED
 *     |        |        |         |            |
 *     +------> CANCELLED          ABORTED      FAILED
 */
const TRANSITIONS: Readonly<Record<DrillStatus, Partial<Record<DrillAction, DrillStatus>>>> = {
  DRAFT: { VALIDATE: 'READY', CANCEL: 'CANCELLED' },
  READY: { ARM: 'ARMED', VALIDATE: 'READY', CANCEL: 'CANCELLED' },
  ARMED: { START: 'RUNNING', ABORT: 'ABORTED', CANCEL: 'CANCELLED' },
  RUNNING: { COMPLETE: 'VERIFYING', ABORT: 'ABORTED', FAIL: 'FAILED' },
  VERIFYING: { VERIFY: 'COMPLETED', FAIL: 'FAILED' },
  // Terminal states.
  COMPLETED: {},
  FAILED: {},
  ABORTED: {},
  CANCELLED: {},
};

export const TERMINAL_STATUSES: readonly DrillStatus[] = [
  'COMPLETED',
  'FAILED',
  'ABORTED',
  'CANCELLED',
];

/** Statuses in which a drill is considered live for the one-live-drill rule (§13). */
export const LIVE_STATUSES: readonly DrillStatus[] = ['ARMED', 'RUNNING', 'VERIFYING'];

export function isTerminal(status: DrillStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface SafetyContext {
  /** An active, uncleared emergency stop for this facility. */
  readonly emergencyStopActive: boolean;
  /** Another drill at this facility is already ARMED/RUNNING/VERIFYING. */
  readonly anotherDrillLive: boolean;
  /** Telemetry is older than the staleness threshold (spec §10.2). */
  readonly telemetryStale: boolean;
  /** Telemetry completeness over the modeling window, 0..1. */
  readonly telemetryCompleteness: number;
  /** Measured inlet temperature has breached the configured thermal limit. */
  readonly thermalLimitExceeded: boolean;
  /** The facility has a CURRENT envelope. */
  readonly envelopeCurrent: boolean;
}

export interface DrillPlan {
  readonly requestedReductionKw: number;
  readonly durationMin: number;
  readonly rampKwPerMin: number;
}

export interface FacilityLimits {
  readonly normalLoadKw: number;
  readonly minimumSafeLoadKw: number;
  readonly maximumCurtailmentKw: number;
  readonly maximumRampKwPerMin: number;
  readonly maximumDurationMin: number;
  /** Current envelope's total reducible kW, when one exists. */
  readonly envelopeReducibleKw: number | null;
}

export interface TransitionRefusal {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export type TransitionResult =
  | { readonly allowed: true; readonly nextStatus: DrillStatus }
  | { readonly allowed: false; readonly refusals: readonly TransitionRefusal[] };

/** Minimum completeness for arming and certification (spec §10.2). */
export const MINIMUM_COMPLETENESS_FOR_DRILL = 0.9;

/**
 * Decides whether an action may be applied to a drill in a given status.
 *
 * Safety checks are evaluated in priority order and ALL applicable refusals are
 * returned, so an operator sees every blocker at once rather than fixing them
 * one at a time.
 */
export function evaluateTransition(input: {
  readonly currentStatus: DrillStatus;
  readonly action: DrillAction;
  readonly safety: SafetyContext;
  readonly plan?: DrillPlan;
  readonly limits?: FacilityLimits;
}): TransitionResult {
  const { currentStatus, action, safety } = input;
  const refusals: TransitionRefusal[] = [];

  // 1. Emergency stop preempts every operation (spec §13.1) — including a
  //    transition that would otherwise be structurally valid. ABORT, CANCEL and
  //    FAIL remain available so a live drill can always be brought down.
  const isDeescalation = action === 'ABORT' || action === 'CANCEL' || action === 'FAIL';
  if (safety.emergencyStopActive && !isDeescalation) {
    refusals.push({
      code: 'EMERGENCY_STOP_ACTIVE',
      message: 'An active emergency stop blocks this operation until it is cleared.',
    });
  }

  // 2. Structural validity of the transition itself.
  const nextStatus = TRANSITIONS[currentStatus][action];
  if (nextStatus === undefined) {
    refusals.push({
      code: 'DRILL_INVALID_TRANSITION',
      message: `Cannot ${action} a drill in status ${currentStatus}.`,
      details: { current_status: currentStatus, action },
    });
    // Without a valid target there is nothing further to check.
    return { allowed: false, refusals };
  }

  // 3. Escalating actions carry the safety burden.
  const isEscalation = action === 'ARM' || action === 'START';
  if (isEscalation) {
    if (safety.anotherDrillLive) {
      refusals.push({
        code: 'DRILL_ALREADY_LIVE',
        message: 'Another drill at this facility is already armed or running.',
      });
    }
    if (safety.telemetryStale) {
      refusals.push({
        code: 'TELEMETRY_STALE',
        message: 'Telemetry is stale; a drill cannot be armed or started.',
      });
    }
    if (safety.telemetryCompleteness < MINIMUM_COMPLETENESS_FOR_DRILL) {
      refusals.push({
        code: 'TELEMETRY_INCOMPLETE',
        message: `Telemetry completeness ${(safety.telemetryCompleteness * 100).toFixed(1)}% is below the ${MINIMUM_COMPLETENESS_FOR_DRILL * 100}% minimum.`,
        details: {
          completeness: safety.telemetryCompleteness,
          required: MINIMUM_COMPLETENESS_FOR_DRILL,
        },
      });
    }
    if (safety.thermalLimitExceeded) {
      refusals.push({
        code: 'THERMAL_LIMIT_EXCEEDED',
        message: 'Measured inlet temperature is at or above the configured thermal limit.',
      });
    }
    if (!safety.envelopeCurrent) {
      refusals.push({
        code: 'ENVELOPE_NOT_CURRENT',
        message: 'A current flexibility envelope is required before arming a drill.',
      });
    }
    if (input.plan && input.limits) {
      refusals.push(...checkPlanAgainstLimits(input.plan, input.limits));
    }
  }

  return refusals.length > 0 ? { allowed: false, refusals } : { allowed: true, nextStatus };
}

/**
 * Safety invariants for the requested plan (spec §13.1). These are hard limits:
 * a plan that violates any of them must never reach ARMED.
 */
export function checkPlanAgainstLimits(
  plan: DrillPlan,
  limits: FacilityLimits,
): TransitionRefusal[] {
  const refusals: TransitionRefusal[] = [];

  // Setpoint must never fall below the minimum safe load.
  const targetLoadKw = limits.normalLoadKw - plan.requestedReductionKw;
  if (targetLoadKw < limits.minimumSafeLoadKw) {
    refusals.push({
      code: 'DRILL_BELOW_MINIMUM_SAFE_LOAD',
      message: `Requested reduction would drive load to ${targetLoadKw} kW, below the ${limits.minimumSafeLoadKw} kW minimum safe load.`,
      details: {
        target_load_kw: targetLoadKw,
        minimum_safe_load_kw: limits.minimumSafeLoadKw,
      },
    });
  }

  if (plan.requestedReductionKw > limits.maximumCurtailmentKw) {
    refusals.push({
      code: 'DRILL_EXCEEDS_ENVELOPE',
      message: `Requested reduction ${plan.requestedReductionKw} kW exceeds the maximum curtailment of ${limits.maximumCurtailmentKw} kW.`,
      details: {
        requested_kw: plan.requestedReductionKw,
        maximum_curtailment_kw: limits.maximumCurtailmentKw,
      },
    });
  }

  // Never promise more than the current envelope supports.
  if (
    limits.envelopeReducibleKw !== null &&
    plan.requestedReductionKw > limits.envelopeReducibleKw
  ) {
    refusals.push({
      code: 'DRILL_EXCEEDS_ENVELOPE',
      message: `Requested reduction ${plan.requestedReductionKw} kW exceeds the current envelope of ${limits.envelopeReducibleKw} kW.`,
      details: {
        requested_kw: plan.requestedReductionKw,
        envelope_reducible_kw: limits.envelopeReducibleKw,
      },
    });
  }

  if (plan.rampKwPerMin > limits.maximumRampKwPerMin) {
    refusals.push({
      code: 'DRILL_EXCEEDS_RAMP_LIMIT',
      message: `Planned ramp ${plan.rampKwPerMin} kW/min exceeds the maximum of ${limits.maximumRampKwPerMin} kW/min.`,
      details: {
        planned_ramp: plan.rampKwPerMin,
        maximum_ramp: limits.maximumRampKwPerMin,
      },
    });
  }

  if (plan.durationMin > limits.maximumDurationMin) {
    refusals.push({
      code: 'DRILL_EXCEEDS_MAX_DURATION',
      message: `Planned duration ${plan.durationMin} min exceeds the maximum of ${limits.maximumDurationMin} min.`,
      details: {
        planned_duration_min: plan.durationMin,
        maximum_duration_min: limits.maximumDurationMin,
      },
    });
  }

  return refusals;
}

/**
 * The drill event that must be written for a transition (spec §13.1:
 * "Every transition writes a drill event and audit log").
 */
export function eventTypeForAction(action: DrillAction): string {
  switch (action) {
    case 'VALIDATE':
      return 'VALIDATED';
    case 'ARM':
      return 'ARMED';
    case 'START':
      return 'STARTED';
    case 'COMPLETE':
      return 'COMPLETED';
    case 'VERIFY':
      return 'COMPLETED';
    case 'ABORT':
      return 'ABORTED';
    case 'CANCEL':
      return 'ABORTED';
    case 'FAIL':
      return 'FAILED';
  }
}
