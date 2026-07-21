/**
 * Agentic drill orchestration.
 *
 * A pure state machine. It decides what should happen next and whether a
 * proposed action is permitted; it never performs the action itself. Execution
 * belongs to an adapter outside this package, which is what keeps the agent
 * testable and keeps database and connector access out of the trust boundary.
 *
 * The safety-critical function here is `authorizeTool`. Everything else is
 * sequencing. Four invariants hold regardless of phase, model output, or caller:
 *
 *   1. A mutating tool requiring approval cannot run without a live approval
 *      bound to the CURRENT plan.
 *   2. An approval is single-use and plan-bound. Approving one plan and then
 *      executing a different one is refused — otherwise a plan could be
 *      re-planned after approval and executed unreviewed.
 *   3. STOP_DRILL is always authorized, in every phase, including while an
 *      emergency stop is latched and after the session has been refused.
 *   4. A latched emergency stop refuses everything except stopping.
 */
import type { ReductionPlan } from '../plan/index.js';
import type { RiskAssessment } from '../risk/index.js';
import { ALWAYS_PERMITTED, TOOL_REGISTRY, type ToolName } from './tools.js';

export const ORCHESTRATOR_VERSION = 'gridflex-agent-1.0.0';

export type AgentPhase =
  | 'GATHERING'
  | 'FORECASTING'
  | 'PLANNING'
  | 'ASSESSING'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'RUNNING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'REFUSED'
  | 'ABORTED';

const TERMINAL_PHASES: readonly AgentPhase[] = ['COMPLETED', 'REFUSED', 'ABORTED'];

export interface Approval {
  /** Fingerprint of the plan the operator actually saw and approved. */
  readonly grantedForPlanFingerprint: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
  /** True once an approval-gated tool has consumed it. */
  readonly consumed: boolean;
}

export interface AgentContext {
  readonly phase: AgentPhase;
  readonly plan: ReductionPlan | null;
  readonly risk: RiskAssessment | null;
  readonly approval: Approval | null;
  readonly emergencyStopActive: boolean;
  readonly drillRunning: boolean;
}

export interface Refusal {
  readonly code: string;
  readonly detail: string;
}

export interface Authorization {
  readonly permitted: boolean;
  readonly tool: ToolName;
  readonly refusals: readonly Refusal[];
}

/**
 * Deterministic fingerprint of a plan's material content.
 *
 * Not a certified hash — the assurance engine owns those, and this package is
 * outside that boundary. Its only job is to detect that the plan changed after
 * an operator approved it, so it must cover every field that alters what the
 * facility will physically do.
 */
export function planFingerprint(plan: ReductionPlan): string {
  const allocations = [...plan.allocations]
    .sort((a, b) => (a.mechanismId < b.mechanismId ? -1 : a.mechanismId > b.mechanismId ? 1 : 0))
    .map((a) => `${a.mechanismId}=${a.allocatedKw}`)
    .join(',');

  return [
    plan.plannerVersion,
    plan.targetReducibleKw,
    plan.allocatedKw,
    String(plan.durationMin),
    plan.aggregateRampKwPerMin,
    String(plan.estimatedResponseSeconds),
    String(plan.reboundWindowMin),
    allocations,
  ].join('|');
}

export function initialContext(): AgentContext {
  return {
    phase: 'GATHERING',
    plan: null,
    risk: null,
    approval: null,
    emergencyStopActive: false,
    drillRunning: false,
  };
}

/**
 * Decides whether a tool may run right now.
 *
 * All applicable refusals are returned together rather than one at a time, so an
 * operator sees every reason at once instead of fixing them serially.
 */
export function authorizeTool(context: AgentContext, tool: ToolName): Authorization {
  // Invariant 3: stopping is always available. Checked before anything else so
  // no later rule can accidentally gate it.
  if (ALWAYS_PERMITTED.includes(tool)) {
    return { permitted: true, tool, refusals: [] };
  }

  const refusals: Refusal[] = [];
  const definition = TOOL_REGISTRY[tool];

  // Invariant 4.
  if (context.emergencyStopActive) {
    refusals.push({
      code: 'EMERGENCY_STOP_ACTIVE',
      detail: 'An emergency stop is latched; only STOP_DRILL is permitted.',
    });
  }

  if (TERMINAL_PHASES.includes(context.phase)) {
    refusals.push({
      code: 'SESSION_TERMINAL',
      detail: `Session is ${context.phase}; no further tools may run.`,
    });
  }

  if (definition.requiresApproval) {
    // Invariants 1 and 2.
    if (context.approval === null) {
      refusals.push({
        code: 'APPROVAL_REQUIRED',
        detail: `${tool} mutates facility state and requires operator approval.`,
      });
    } else if (context.approval.consumed) {
      refusals.push({
        code: 'APPROVAL_ALREADY_CONSUMED',
        detail: 'This approval has already been used; a fresh approval is required.',
      });
    } else if (context.plan === null) {
      refusals.push({
        code: 'NO_PLAN',
        detail: 'An approval exists but there is no plan to execute.',
      });
    } else {
      const current = planFingerprint(context.plan);
      if (current !== context.approval.grantedForPlanFingerprint) {
        refusals.push({
          code: 'APPROVAL_PLAN_MISMATCH',
          detail:
            'The plan changed after approval was granted. The operator approved a different ' +
            'plan, so this one has not been reviewed.',
        });
      }
    }
  }

  // A blocking risk assessment stops any mutation, approved or not. Approval is
  // permission to act, never permission to override a safety constraint.
  if (definition.mutates && context.risk !== null && context.risk.blocked) {
    refusals.push({
      code: 'RISK_BLOCKED',
      detail: `Risk assessment is ${context.risk.level}: ${context.risk.summary}`,
    });
  }

  return { permitted: refusals.length === 0, tool, refusals };
}

/**
 * The next tool the workflow calls for, or null when nothing is pending.
 *
 * Sequencing only — it never bypasses `authorizeTool`, and a caller that follows
 * this blindly still cannot execute an unauthorized tool.
 */
export function nextTool(context: AgentContext): ToolName | null {
  if (context.emergencyStopActive && context.drillRunning) return 'STOP_DRILL';
  if (TERMINAL_PHASES.includes(context.phase)) return null;

  switch (context.phase) {
    case 'GATHERING':
      return 'READ_TELEMETRY';
    case 'FORECASTING':
      return 'FORECAST_FLEXIBILITY';
    case 'PLANNING':
      return 'PLAN_REDUCTION';
    case 'ASSESSING':
      return 'ASSESS_RISK';
    case 'AWAITING_APPROVAL':
      return 'REQUEST_APPROVAL';
    case 'APPROVED':
      return 'START_DRILL';
    case 'RUNNING':
      return 'MONITOR_DRILL';
    case 'VERIFYING':
      return 'VERIFY_DELIVERY';
    default:
      return null;
  }
}

export interface StepEvent {
  readonly tool: ToolName;
  readonly succeeded: boolean;
  readonly plan?: ReductionPlan;
  readonly risk?: RiskAssessment;
  readonly approval?: Approval;
  /** Set when monitoring detects the drill has finished or must end. */
  readonly drillFinished?: boolean;
}

/** Advances the session after a tool has run. Pure. */
export function applyResult(context: AgentContext, event: StepEvent): AgentContext {
  if (event.tool === 'STOP_DRILL') {
    return { ...context, phase: 'ABORTED', drillRunning: false };
  }

  if (!event.succeeded) {
    return { ...context, phase: 'REFUSED' };
  }

  switch (event.tool) {
    case 'READ_TELEMETRY':
      return { ...context, phase: 'FORECASTING' };

    case 'FORECAST_FLEXIBILITY':
      return { ...context, phase: 'PLANNING' };

    case 'PLAN_REDUCTION': {
      const plan = event.plan ?? null;
      // A re-plan invalidates any existing approval outright. Leaving a stale
      // approval attached would rely on the fingerprint check alone; clearing it
      // means two independent mechanisms must both fail to execute unreviewed.
      return { ...context, phase: 'ASSESSING', plan, approval: null };
    }

    case 'ASSESS_RISK': {
      const risk = event.risk ?? null;
      if (risk !== null && risk.blocked) {
        return { ...context, risk, phase: 'REFUSED' };
      }
      return { ...context, risk, phase: 'AWAITING_APPROVAL' };
    }

    case 'REQUEST_APPROVAL': {
      const approval = event.approval;
      if (approval === undefined) return context;
      return { ...context, approval, phase: 'APPROVED' };
    }

    case 'START_DRILL':
      return {
        ...context,
        phase: 'RUNNING',
        drillRunning: true,
        approval:
          context.approval === null ? null : { ...context.approval, consumed: true },
      };

    case 'MONITOR_DRILL':
      return event.drillFinished === true
        ? { ...context, phase: 'VERIFYING', drillRunning: false }
        : context;

    case 'VERIFY_DELIVERY':
      return { ...context, phase: 'COMPLETED' };

    default:
      return context;
  }
}
