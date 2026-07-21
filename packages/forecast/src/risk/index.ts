/**
 * Risk assessment.
 *
 * Runs before a plan is offered for approval and answers: what could go wrong if
 * we do this? Every check is deterministic TypeScript. No model output influences
 * whether a risk is raised — a language model that could talk its way past a
 * thermal limit is not a safety layer.
 *
 * The output is advisory in one direction only. It can BLOCK a plan, and it can
 * never clear one that the envelope or planner already refused.
 */
import { kwStringToMilliKw, milliKwToKwString } from '@gridflex/engine';
import type { ReductionPlan } from '../plan/index.js';
import type { SafetyStatus } from '../safety/index.js';

export const RISK_ENGINE_VERSION = 'gridflex-risk-1.0.0';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKED';

export type RiskSeverity = 'INFO' | 'WARNING' | 'BLOCKER';

export interface RiskFactor {
  readonly code: string;
  readonly severity: RiskSeverity;
  readonly detail: string;
  readonly facts: Record<string, unknown>;
}

/** Age beyond which telemetry cannot be trusted to describe the facility now. */
export const MAXIMUM_TELEMETRY_AGE_SECONDS = 900;

/** Thermal margin below which raising setpoints stops being safe. */
export const MINIMUM_THERMAL_MARGIN_C = 2;

/** State of charge below which storage should not be committed to a drill. */
export const MINIMUM_BATTERY_STATE_OF_CHARGE = 0.4;

export interface RiskInput {
  readonly plan: ReductionPlan;
  /** Assurance grade of the envelope backing this plan. */
  readonly envelopeConfidence: number;
  readonly envelopeStatus: 'DRAFT' | 'BLOCKED';
  /** True when the forecaster flagged its interval as underpowered. */
  readonly forecastIntervalUnderpowered: boolean;
  /** Age of the newest telemetry reading, in seconds. */
  readonly telemetryAgeSeconds: number;
  readonly telemetryCompleteness: number;
  /**
   * Degrees C between current temperature and the thermal limit, or null when
   * no measurement backs it. Callers should derive this via
   * `safety.thermalMarginC`, which returns null for simulated, stale, or absent
   * readings rather than passing a number that looks measured.
   */
  readonly thermalMarginC: number | null;
  /** Battery state of charge in [0, 1], or null when unbacked. */
  readonly batteryStateOfCharge: number | null;
  /**
   * Provenance of the safety signals, when available. Supplied so a refusal can
   * say WHY the value is missing — "the sensor is simulated" and "there is no
   * sensor" are different operational problems with different fixes.
   */
  readonly safetyProvenance?: {
    readonly thermalStatus: SafetyStatus;
    readonly stateOfChargeStatus: SafetyStatus;
    readonly simulationDrill: boolean;
  };
  /** Completed drills at this facility, and how many delivered on target. */
  readonly priorDrillCount: number;
  readonly priorDrillSuccessCount: number;
  /** True when an emergency stop is currently latched. */
  readonly emergencyStopActive: boolean;
}

export interface RiskAssessment {
  readonly riskEngineVersion: string;
  readonly level: RiskLevel;
  readonly factors: readonly RiskFactor[];
  /** True when at least one BLOCKER factor was raised. */
  readonly blocked: boolean;
  readonly summary: string;
}

function factor(
  code: string,
  severity: RiskSeverity,
  detail: string,
  facts: Record<string, unknown>,
): RiskFactor {
  return { code, severity, detail, facts };
}

export function assessRisk(input: RiskInput): RiskAssessment {
  const factors: RiskFactor[] = [];
  const { plan } = input;

  // An emergency stop outranks everything. Nothing may be armed while latched.
  if (input.emergencyStopActive) {
    factors.push(
      factor('EMERGENCY_STOP_ACTIVE', 'BLOCKER', 'An emergency stop is latched; no drill may be armed.', {
        emergency_stop_active: true,
      }),
    );
  }

  if (input.envelopeStatus === 'BLOCKED') {
    factors.push(
      factor('ENVELOPE_BLOCKED', 'BLOCKER', 'The envelope backing this plan is BLOCKED.', {
        envelope_status: input.envelopeStatus,
      }),
    );
  }

  if (!plan.feasible) {
    factors.push(
      factor(
        'PLAN_NOT_FEASIBLE',
        'BLOCKER',
        `Plan falls ${plan.shortfallKw} kW short of its ${plan.targetReducibleKw} kW target.`,
        { shortfall_kw: plan.shortfallKw, target_kw: plan.targetReducibleKw },
      ),
    );
  }

  // Stale telemetry means the facility state driving this plan may no longer
  // hold. This is a blocker rather than a warning: acting on a stale picture is
  // how a minimum-load floor gets crossed without anyone seeing it.
  if (input.telemetryAgeSeconds > MAXIMUM_TELEMETRY_AGE_SECONDS) {
    factors.push(
      factor(
        'TELEMETRY_STALE',
        'BLOCKER',
        `Newest telemetry is ${input.telemetryAgeSeconds}s old, beyond the ` +
          `${MAXIMUM_TELEMETRY_AGE_SECONDS}s limit.`,
        {
          telemetry_age_seconds: input.telemetryAgeSeconds,
          limit_seconds: MAXIMUM_TELEMETRY_AGE_SECONDS,
        },
      ),
    );
  }

  if (input.telemetryCompleteness < 0.9) {
    factors.push(
      factor(
        'TELEMETRY_INCOMPLETE',
        'WARNING',
        `Telemetry completeness is ${(input.telemetryCompleteness * 100).toFixed(1)}%.`,
        { completeness: input.telemetryCompleteness },
      ),
    );
  }

  // Thermal margin only matters when the plan actually draws on cooling.
  const usesCooling = plan.allocations.some((a) => a.mechanismType === 'COOLING');
  if (usesCooling) {
    if (input.thermalMarginC === null) {
      const status = input.safetyProvenance?.thermalStatus;
      factors.push(
        factor(
          status === 'SIMULATED' ? 'THERMAL_MARGIN_SIMULATED' : 'THERMAL_MARGIN_UNKNOWN',
          'BLOCKER',
          status === 'SIMULATED'
            ? 'Plan raises cooling setpoints, but the only thermal reading is simulated. ' +
              'Simulated safety telemetry cannot authorise a real reduction.'
            : status === 'STALE'
              ? 'Plan raises cooling setpoints, but the newest thermal reading is too old to describe the facility now.'
              : 'Plan raises cooling setpoints but no thermal margin is available.',
          { uses_cooling: true, thermal_status: status ?? 'UNKNOWN' },
        ),
      );
    } else if (input.thermalMarginC < MINIMUM_THERMAL_MARGIN_C) {
      factors.push(
        factor(
          'THERMAL_MARGIN_INSUFFICIENT',
          'BLOCKER',
          `Thermal margin is ${input.thermalMarginC}C, below the ${MINIMUM_THERMAL_MARGIN_C}C minimum.`,
          { thermal_margin_c: input.thermalMarginC, minimum_c: MINIMUM_THERMAL_MARGIN_C },
        ),
      );
    }
  }

  // Same for storage: only assessed when the plan actually discharges it.
  const usesStorage = plan.allocations.some((a) => a.mechanismType === 'STORAGE');
  if (usesStorage) {
    if (input.batteryStateOfCharge === null) {
      const status = input.safetyProvenance?.stateOfChargeStatus;
      factors.push(
        factor(
          status === 'SIMULATED' ? 'BATTERY_SOC_SIMULATED' : 'BATTERY_SOC_UNKNOWN',
          'BLOCKER',
          status === 'SIMULATED'
            ? 'Plan discharges storage, but the only state-of-charge reading is simulated. ' +
              'Simulated safety telemetry cannot authorise a real discharge.'
            : status === 'STALE'
              ? 'Plan discharges storage, but the newest state-of-charge reading is too old.'
              : 'Plan discharges storage but state of charge is unknown.',
          { uses_storage: true, state_of_charge_status: status ?? 'UNKNOWN' },
        ),
      );
    } else if (input.batteryStateOfCharge < MINIMUM_BATTERY_STATE_OF_CHARGE) {
      factors.push(
        factor(
          'BATTERY_SOC_LOW',
          'BLOCKER',
          `State of charge ${(input.batteryStateOfCharge * 100).toFixed(0)}% is below the ` +
            `${MINIMUM_BATTERY_STATE_OF_CHARGE * 100}% reserve.`,
          {
            state_of_charge: input.batteryStateOfCharge,
            minimum: MINIMUM_BATTERY_STATE_OF_CHARGE,
          },
        ),
      );
    }
  }

  if (input.forecastIntervalUnderpowered) {
    factors.push(
      factor(
        'FORECAST_INTERVAL_UNDERPOWERED',
        'WARNING',
        'The forecast interval reflects too little history to describe day-to-day variation.',
        { interval_underpowered: true },
      ),
    );
  }

  if (input.envelopeConfidence < 0.5) {
    factors.push(
      factor(
        'LOW_ASSURANCE_GRADE',
        'WARNING',
        `Envelope confidence is ${input.envelopeConfidence}; capacity is largely unproven.`,
        { envelope_confidence: input.envelopeConfidence },
      ),
    );
  }

  // Operating history. A facility that has never drilled is not a failure, but
  // it is meaningfully less predictable than one with a track record.
  if (input.priorDrillCount === 0) {
    factors.push(
      factor('NO_DRILL_HISTORY', 'WARNING', 'This facility has no completed drills.', {
        prior_drill_count: 0,
      }),
    );
  } else {
    const successRate = input.priorDrillSuccessCount / input.priorDrillCount;
    if (successRate < 0.5) {
      factors.push(
        factor(
          'POOR_DRILL_HISTORY',
          'WARNING',
          `Only ${input.priorDrillSuccessCount} of ${input.priorDrillCount} prior drills delivered on target.`,
          {
            prior_drill_count: input.priorDrillCount,
            prior_drill_success_count: input.priorDrillSuccessCount,
            success_rate: Number(successRate.toFixed(4)),
          },
        ),
      );
    }
  }

  // Rebound. A large reduction over a short recovery window risks a spike that
  // can exceed the original load, which is a grid problem, not just a local one.
  if (plan.reboundWindowMin > 0 && plan.allocatedMkw > 0n) {
    const reboundRateMkwPerMin = Number(plan.allocatedMkw) / plan.reboundWindowMin;
    const aggregateRampMkwPerMin = Number(kwStringToMilliKw(plan.aggregateRampKwPerMin));
    if (aggregateRampMkwPerMin > 0 && reboundRateMkwPerMin > aggregateRampMkwPerMin) {
      factors.push(
        factor(
          'REBOUND_EXCEEDS_RAMP',
          'WARNING',
          `Recovering ${plan.allocatedKw} kW over ${plan.reboundWindowMin} min implies a faster ` +
            'rate than the facility ramped down at.',
          {
            allocated_kw: plan.allocatedKw,
            rebound_window_min: plan.reboundWindowMin,
            implied_rebound_kw_per_min: milliKwToKwString(BigInt(Math.round(reboundRateMkwPerMin))),
            aggregate_ramp_kw_per_min: plan.aggregateRampKwPerMin,
          },
        ),
      );
    }
  }

  for (const decision of plan.decisions) {
    if (decision.decisionCode === 'RAMP_TOO_SLOW_FOR_RESPONSE_WINDOW') {
      factors.push(
        factor('RAMP_TOO_SLOW', 'WARNING', 'Plan cannot reach its target inside the response window.', decision.facts),
      );
    }
    if (decision.decisionCode === 'RAMP_RATE_UNKNOWN') {
      factors.push(
        factor('RAMP_RATE_UNKNOWN', 'WARNING', 'No allocated mechanism declares a ramp rate.', decision.facts),
      );
    }
  }

  const blocked = factors.some((f) => f.severity === 'BLOCKER');
  const warnings = factors.filter((f) => f.severity === 'WARNING').length;

  const level: RiskLevel = blocked ? 'BLOCKED' : warnings >= 3 ? 'HIGH' : warnings >= 1 ? 'MEDIUM' : 'LOW';

  const summary = blocked
    ? `Blocked by ${factors.filter((f) => f.severity === 'BLOCKER').length} constraint(s).`
    : warnings === 0
      ? 'No risk factors identified.'
      : `${warnings} warning(s); no blocking constraint.`;

  return { riskEngineVersion: RISK_ENGINE_VERSION, level, factors, blocked, summary };
}
