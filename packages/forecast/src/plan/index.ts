/**
 * Reduction planner.
 *
 * Decides WHERE a committed reduction comes from: which mechanisms contribute
 * how much, in what order, and whether the target is reachable at all.
 *
 * Planning is at mechanism granularity. The schema has no workload/job table, so
 * rather than inventing one for a connector that does not exist, per-mechanism
 * hints are read from the existing `metadata` jsonb and the planner degrades
 * cleanly when they are absent.
 *
 * The planner is deterministic and allocates nothing it cannot justify. Three
 * constraints bind independently, and a mechanism failing any one of them is
 * excluded with the reason recorded:
 *
 *   - duration: a mechanism that cannot sustain the full window is unusable,
 *     because a drill that collapses halfway through is a failed drill
 *   - ramp: the aggregate ramp must reach the target inside the response window
 *   - capacity: nothing may be allocated beyond a mechanism's own cap
 */
import { type MilliKw, kwStringToMilliKw, milliKwToKwString } from '@gridflex/engine';

export const PLANNER_VERSION = 'gridflex-planner-1.0.0';

/** Mechanism families, mirroring `flexibility_mechanisms.mechanism_type`. */
export type MechanismType = 'WORKLOAD' | 'STORAGE' | 'COOLING' | 'OTHER';

/**
 * Order mechanisms are drawn on, least disruptive first.
 *
 * Deferring batch compute delays work that was going to finish later anyway.
 * Discharging storage consumes a finite reserve needed for actual outages.
 * Raising cooling setpoints moves the facility toward a thermal limit, which is
 * the only one of the three that can damage equipment. A facility may override
 * this per mechanism via `metadata.disruptionRank`.
 */
export const DEFAULT_DISRUPTION_RANK: Readonly<Record<MechanismType, number>> = {
  WORKLOAD: 1,
  STORAGE: 2,
  COOLING: 3,
  OTHER: 4,
};

/** Seconds a facility is allowed to take reaching the committed reduction. */
export const DEFAULT_RESPONSE_WINDOW_SECONDS = 600;

export interface PlanMechanismInput {
  readonly id: string;
  readonly code: string;
  readonly mechanismType: MechanismType;
  readonly enabled: boolean;
  /** Cap for this mechanism, already bounded by the envelope. Decimal kW string. */
  readonly availableKw: string;
  readonly rampKwPerMin: string | null;
  readonly maximumDurationMin: number | null;
  readonly reboundWindowMin: number | null;
  /** Optional per-mechanism hints from `flexibility_mechanisms.metadata`. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PlanRequest {
  /** Reduction to plan for. Must already be the clamped, envelope-bounded claim. */
  readonly targetReducibleKw: string;
  readonly durationMin: number;
  readonly mechanisms: readonly PlanMechanismInput[];
  readonly responseWindowSeconds?: number;
}

export interface Allocation {
  readonly mechanismId: string;
  readonly code: string;
  readonly mechanismType: MechanismType;
  readonly allocatedKw: string;
  readonly allocatedMkw: MilliKw;
  readonly disruptionRank: number;
  readonly reboundWindowMin: number | null;
}

export interface ExcludedMechanism {
  readonly code: string;
  readonly reasonCode: string;
  readonly detail: string;
}

export interface PlanDecision {
  readonly decisionType: string;
  readonly decisionCode: string;
  readonly severity: 'INFO' | 'WARNING' | 'BLOCKER';
  readonly facts: Record<string, unknown>;
}

export interface ReductionPlan {
  readonly plannerVersion: string;
  readonly feasible: boolean;
  readonly targetReducibleKw: string;
  readonly allocatedKw: string;
  readonly allocatedMkw: MilliKw;
  /** Target minus allocated. Zero when the plan meets its target. */
  readonly shortfallKw: string;
  readonly durationMin: number;
  readonly allocations: readonly Allocation[];
  readonly excluded: readonly ExcludedMechanism[];
  /** Aggregate ramp of the allocated mechanisms. */
  readonly aggregateRampKwPerMin: string;
  /** Time to reach the allocated reduction at the aggregate ramp. */
  readonly estimatedResponseSeconds: number;
  /** Longest rebound window among allocated mechanisms; drives post-drill watch. */
  readonly reboundWindowMin: number;
  readonly decisions: readonly PlanDecision[];
}

const ZERO_KW = '0.000';

/** Reads an integer hint from metadata, ignoring anything not a clean integer. */
function integerHint(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | null {
  const raw = metadata?.[key];
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return null;
}

export function disruptionRankOf(mechanism: PlanMechanismInput): number {
  return (
    integerHint(mechanism.metadata, 'disruptionRank') ??
    DEFAULT_DISRUPTION_RANK[mechanism.mechanismType]
  );
}

export function planReduction(request: PlanRequest): ReductionPlan {
  const { durationMin } = request;
  if (!Number.isInteger(durationMin) || durationMin <= 0) {
    throw new RangeError(`Duration must be a positive integer minutes, received ${durationMin}`);
  }

  const targetMkw = kwStringToMilliKw(request.targetReducibleKw);
  if (targetMkw < 0n) {
    throw new RangeError('Target reduction may not be negative');
  }

  const responseWindowSeconds = request.responseWindowSeconds ?? DEFAULT_RESPONSE_WINDOW_SECONDS;
  const excluded: ExcludedMechanism[] = [];
  const decisions: PlanDecision[] = [];

  // Eligibility. Each exclusion is recorded so an operator can see what was
  // available but unusable, rather than only what was chosen.
  const eligible: PlanMechanismInput[] = [];
  for (const mechanism of request.mechanisms) {
    if (!mechanism.enabled) {
      excluded.push({
        code: mechanism.code,
        reasonCode: 'MECHANISM_DISABLED',
        detail: 'Mechanism is disabled.',
      });
      continue;
    }

    const available = kwStringToMilliKw(mechanism.availableKw);
    if (available <= 0n) {
      excluded.push({
        code: mechanism.code,
        reasonCode: 'NO_AVAILABLE_CAPACITY',
        detail: `Available capacity is ${mechanism.availableKw} kW.`,
      });
      continue;
    }

    // A mechanism that cannot hold for the whole window is not partially
    // useful — it would drop out mid-drill and turn a pass into a failure.
    if (mechanism.maximumDurationMin !== null && mechanism.maximumDurationMin < durationMin) {
      excluded.push({
        code: mechanism.code,
        reasonCode: 'DURATION_EXCEEDS_MECHANISM_LIMIT',
        detail:
          `Mechanism sustains ${mechanism.maximumDurationMin} min but the drill requires ` +
          `${durationMin} min.`,
      });
      decisions.push({
        decisionType: 'PLAN_ELIGIBILITY',
        decisionCode: 'DURATION_EXCEEDS_MECHANISM_LIMIT',
        severity: 'INFO',
        facts: {
          mechanism: mechanism.code,
          mechanism_max_duration_min: mechanism.maximumDurationMin,
          requested_duration_min: durationMin,
          forgone_kw: mechanism.availableKw,
        },
      });
      continue;
    }

    eligible.push(mechanism);
  }

  // Least disruptive first; ties broken by code so the plan is deterministic.
  const ordered = [...eligible].sort((a, b) => {
    const rankDelta = disruptionRankOf(a) - disruptionRankOf(b);
    return rankDelta !== 0 ? rankDelta : a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });

  const allocations: Allocation[] = [];
  let remaining = targetMkw;
  let aggregateRampMkwPerMin = 0n;

  for (const mechanism of ordered) {
    if (remaining <= 0n) break;

    const available = kwStringToMilliKw(mechanism.availableKw);
    const take = available < remaining ? available : remaining;

    allocations.push({
      mechanismId: mechanism.id,
      code: mechanism.code,
      mechanismType: mechanism.mechanismType,
      allocatedKw: milliKwToKwString(take),
      allocatedMkw: take,
      disruptionRank: disruptionRankOf(mechanism),
      reboundWindowMin: mechanism.reboundWindowMin,
    });

    if (mechanism.rampKwPerMin !== null) {
      aggregateRampMkwPerMin += kwStringToMilliKw(mechanism.rampKwPerMin);
    }
    remaining -= take;
  }

  const allocatedMkw = targetMkw - remaining;
  const shortfallMkw = remaining;
  const feasible = shortfallMkw === 0n && allocations.length > 0;

  if (!feasible && targetMkw > 0n) {
    decisions.push({
      decisionType: 'PLAN_FEASIBILITY',
      decisionCode: 'PLAN_SHORTFALL',
      severity: 'BLOCKER',
      facts: {
        target_kw: request.targetReducibleKw,
        allocated_kw: milliKwToKwString(allocatedMkw),
        shortfall_kw: milliKwToKwString(shortfallMkw),
        eligible_mechanisms: eligible.length,
        excluded_mechanisms: excluded.length,
      },
    });
  }

  // Ramp feasibility. Zero aggregate ramp with a nonzero allocation means no
  // mechanism declared a rate, so response time is unknown rather than instant.
  let estimatedResponseSeconds = 0;
  if (allocatedMkw > 0n) {
    if (aggregateRampMkwPerMin > 0n) {
      const minutes = Number(allocatedMkw) / Number(aggregateRampMkwPerMin);
      estimatedResponseSeconds = Math.ceil(minutes * 60);
      if (estimatedResponseSeconds > responseWindowSeconds) {
        decisions.push({
          decisionType: 'PLAN_RAMP',
          decisionCode: 'RAMP_TOO_SLOW_FOR_RESPONSE_WINDOW',
          severity: 'WARNING',
          facts: {
            estimated_response_seconds: estimatedResponseSeconds,
            response_window_seconds: responseWindowSeconds,
            aggregate_ramp_kw_per_min: milliKwToKwString(aggregateRampMkwPerMin),
          },
        });
      }
    } else {
      decisions.push({
        decisionType: 'PLAN_RAMP',
        decisionCode: 'RAMP_RATE_UNKNOWN',
        severity: 'WARNING',
        facts: { allocated_kw: milliKwToKwString(allocatedMkw) },
      });
    }
  }

  const reboundWindowMin = allocations.reduce(
    (widest, allocation) => Math.max(widest, allocation.reboundWindowMin ?? 0),
    0,
  );

  return {
    plannerVersion: PLANNER_VERSION,
    feasible,
    targetReducibleKw: request.targetReducibleKw,
    allocatedKw: milliKwToKwString(allocatedMkw),
    allocatedMkw,
    shortfallKw: shortfallMkw > 0n ? milliKwToKwString(shortfallMkw) : ZERO_KW,
    durationMin,
    allocations,
    excluded,
    aggregateRampKwPerMin: milliKwToKwString(aggregateRampMkwPerMin),
    estimatedResponseSeconds,
    reboundWindowMin,
    decisions,
  };
}
