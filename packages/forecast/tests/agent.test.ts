import { describe, expect, it } from 'vitest';
import { planReduction, type PlanMechanismInput, type ReductionPlan } from '../src/plan/index.js';
import { assessRisk, type RiskAssessment } from '../src/risk/index.js';
import { TOOL_REGISTRY, isMutating, requiresApproval, type ToolName } from '../src/agent/tools.js';
import {
  applyResult,
  authorizeTool,
  initialContext,
  nextTool,
  planFingerprint,
  type AgentContext,
} from '../src/agent/orchestrator.js';

const MECHANISMS: PlanMechanismInput[] = [
  {
    id: 'm-workload',
    code: 'WORKLOAD_DEFERRAL',
    mechanismType: 'WORKLOAD',
    enabled: true,
    availableKw: '350.000',
    rampKwPerMin: '80.000',
    maximumDurationMin: 60,
    reboundWindowMin: 20,
  },
];

const PLAN = planReduction({
  targetReducibleKw: '300.000',
  durationMin: 30,
  mechanisms: MECHANISMS,
});

const CLEAN_RISK = assessRisk({
  plan: PLAN,
  envelopeConfidence: 0.85,
  envelopeStatus: 'DRAFT',
  forecastIntervalUnderpowered: false,
  telemetryAgeSeconds: 60,
  telemetryCompleteness: 1,
  thermalMarginC: 8,
  batteryStateOfCharge: 0.9,
  priorDrillCount: 4,
  priorDrillSuccessCount: 4,
  emergencyStopActive: false,
});

const BLOCKED_RISK = assessRisk({
  plan: PLAN,
  envelopeConfidence: 0.85,
  envelopeStatus: 'DRAFT',
  forecastIntervalUnderpowered: false,
  telemetryAgeSeconds: 60,
  telemetryCompleteness: 1,
  thermalMarginC: 8,
  batteryStateOfCharge: 0.9,
  priorDrillCount: 4,
  priorDrillSuccessCount: 4,
  emergencyStopActive: true,
});

function approvedContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    phase: 'APPROVED',
    plan: PLAN,
    risk: CLEAN_RISK,
    approval: {
      grantedForPlanFingerprint: planFingerprint(PLAN),
      grantedBy: 'operator@example.com',
      grantedAt: '2026-07-21T12:00:00Z',
      consumed: false,
    },
    emergencyStopActive: false,
    drillRunning: false,
    ...overrides,
  };
}

const ALL_TOOLS = Object.keys(TOOL_REGISTRY) as ToolName[];

describe('tool registry', () => {
  it('marks every state-changing tool as mutating', () => {
    for (const tool of ['REQUEST_APPROVAL', 'START_DRILL', 'STOP_DRILL', 'UPDATE_PASSPORT'] as const) {
      expect(isMutating(tool)).toBe(true);
    }
  });

  it('gates the tools that change the physical facility or the record', () => {
    expect(requiresApproval('START_DRILL')).toBe(true);
    expect(requiresApproval('UPDATE_PASSPORT')).toBe(true);
  });

  it('does NOT gate STOP_DRILL, even though it mutates', () => {
    // The one failure this system must never have.
    expect(isMutating('STOP_DRILL')).toBe(true);
    expect(requiresApproval('STOP_DRILL')).toBe(false);
  });

  it('gates no read-only tool', () => {
    for (const tool of ALL_TOOLS) {
      if (!TOOL_REGISTRY[tool].mutates) {
        expect(requiresApproval(tool)).toBe(false);
      }
    }
  });
});

describe('authorizeTool — approval gate', () => {
  it('refuses START_DRILL with no approval', () => {
    const context: AgentContext = { ...approvedContext(), approval: null };
    const auth = authorizeTool(context, 'START_DRILL');
    expect(auth.permitted).toBe(false);
    expect(auth.refusals.some((r) => r.code === 'APPROVAL_REQUIRED')).toBe(true);
  });

  it('permits START_DRILL with a live, matching approval', () => {
    expect(authorizeTool(approvedContext(), 'START_DRILL').permitted).toBe(true);
  });

  it('refuses a consumed approval', () => {
    const context = approvedContext({
      approval: { ...approvedContext().approval!, consumed: true },
    });
    const auth = authorizeTool(context, 'START_DRILL');
    expect(auth.refusals.some((r) => r.code === 'APPROVAL_ALREADY_CONSUMED')).toBe(true);
  });

  it('REFUSES when the plan changed after approval', () => {
    // The attack this prevents: get a small plan approved, then re-plan to a
    // larger reduction and execute it against the original approval.
    const biggerPlan = planReduction({
      targetReducibleKw: '350.000',
      durationMin: 30,
      mechanisms: MECHANISMS,
    });
    const context = approvedContext({ plan: biggerPlan });

    const auth = authorizeTool(context, 'START_DRILL');
    expect(auth.permitted).toBe(false);
    expect(auth.refusals.some((r) => r.code === 'APPROVAL_PLAN_MISMATCH')).toBe(true);
  });

  it('refuses an approval with no plan attached', () => {
    const context = approvedContext({ plan: null });
    expect(authorizeTool(context, 'START_DRILL').refusals.some((r) => r.code === 'NO_PLAN')).toBe(true);
  });

  it('applies the same gate to UPDATE_PASSPORT', () => {
    const context: AgentContext = { ...approvedContext(), approval: null };
    expect(authorizeTool(context, 'UPDATE_PASSPORT').permitted).toBe(false);
  });

  it('does not gate read-only tools behind approval', () => {
    const context: AgentContext = { ...approvedContext(), phase: 'GATHERING', approval: null };
    for (const tool of ALL_TOOLS) {
      if (!TOOL_REGISTRY[tool].mutates) {
        expect(authorizeTool(context, tool).permitted, tool).toBe(true);
      }
    }
  });
});

describe('authorizeTool — STOP_DRILL is never blocked', () => {
  const phases = [
    'GATHERING',
    'FORECASTING',
    'PLANNING',
    'ASSESSING',
    'AWAITING_APPROVAL',
    'APPROVED',
    'RUNNING',
    'VERIFYING',
    'COMPLETED',
    'REFUSED',
    'ABORTED',
  ] as const;

  it.each(phases)('is permitted in phase %s', (phase) => {
    expect(authorizeTool(approvedContext({ phase }), 'STOP_DRILL').permitted).toBe(true);
  });

  it('is permitted with an emergency stop latched', () => {
    expect(
      authorizeTool(approvedContext({ emergencyStopActive: true }), 'STOP_DRILL').permitted,
    ).toBe(true);
  });

  it('is permitted with no approval and a blocking risk', () => {
    const context = approvedContext({ approval: null, risk: BLOCKED_RISK });
    expect(authorizeTool(context, 'STOP_DRILL').permitted).toBe(true);
  });

  it('EXHAUSTIVE: permitted under every combination of blocking conditions', () => {
    for (const phase of phases) {
      for (const emergencyStopActive of [false, true]) {
        for (const risk of [null, CLEAN_RISK, BLOCKED_RISK]) {
          for (const approval of [null, approvedContext().approval]) {
            const context = approvedContext({ phase, emergencyStopActive, risk, approval });
            expect(authorizeTool(context, 'STOP_DRILL').permitted).toBe(true);
          }
        }
      }
    }
  });
});

describe('authorizeTool — emergency stop', () => {
  it('refuses every non-stop tool while latched', () => {
    const context = approvedContext({ emergencyStopActive: true });
    for (const tool of ALL_TOOLS) {
      if (tool === 'STOP_DRILL') continue;
      const auth = authorizeTool(context, tool);
      expect(auth.permitted, tool).toBe(false);
      expect(auth.refusals.some((r) => r.code === 'EMERGENCY_STOP_ACTIVE')).toBe(true);
    }
  });
});

describe('authorizeTool — risk blocking', () => {
  it('refuses mutation when risk is blocked, even with a valid approval', () => {
    // Approval is permission to act, never permission to override a constraint.
    const context = approvedContext({ risk: BLOCKED_RISK });
    const auth = authorizeTool(context, 'START_DRILL');
    expect(auth.permitted).toBe(false);
    expect(auth.refusals.some((r) => r.code === 'RISK_BLOCKED')).toBe(true);
  });

  it('still allows read-only tools when risk is blocked', () => {
    const context = approvedContext({ risk: BLOCKED_RISK, phase: 'ASSESSING' });
    expect(authorizeTool(context, 'READ_TELEMETRY').permitted).toBe(true);
  });
});

describe('authorizeTool — terminal sessions', () => {
  it.each(['COMPLETED', 'REFUSED', 'ABORTED'] as const)('refuses tools in phase %s', (phase) => {
    const auth = authorizeTool(approvedContext({ phase }), 'START_DRILL');
    expect(auth.permitted).toBe(false);
    expect(auth.refusals.some((r) => r.code === 'SESSION_TERMINAL')).toBe(true);
  });

  it('reports all applicable refusals together, not one at a time', () => {
    const context = approvedContext({
      phase: 'REFUSED',
      emergencyStopActive: true,
      approval: null,
      risk: BLOCKED_RISK,
    });
    const codes = authorizeTool(context, 'START_DRILL').refusals.map((r) => r.code);
    expect(codes).toContain('EMERGENCY_STOP_ACTIVE');
    expect(codes).toContain('SESSION_TERMINAL');
    expect(codes).toContain('APPROVAL_REQUIRED');
    expect(codes).toContain('RISK_BLOCKED');
  });
});

describe('planFingerprint', () => {
  it('is stable for the same plan', () => {
    expect(planFingerprint(PLAN)).toBe(planFingerprint(PLAN));
  });

  it('changes when the allocated total changes', () => {
    const other = planReduction({
      targetReducibleKw: '350.000',
      durationMin: 30,
      mechanisms: MECHANISMS,
    });
    expect(planFingerprint(other)).not.toBe(planFingerprint(PLAN));
  });

  it('changes when the duration changes', () => {
    const other = planReduction({
      targetReducibleKw: '300.000',
      durationMin: 45,
      mechanisms: MECHANISMS,
    });
    expect(planFingerprint(other)).not.toBe(planFingerprint(PLAN));
  });

  it('changes when the allocation moves between mechanisms', () => {
    // Same total, different physical action — must not compare equal.
    const twoMechanisms: PlanMechanismInput[] = [
      { ...(MECHANISMS[0] as PlanMechanismInput), availableKw: '150.000' },
      {
        ...(MECHANISMS[0] as PlanMechanismInput),
        id: 'm-other',
        code: 'OTHER',
        availableKw: '150.000',
      },
    ];
    const split = planReduction({
      targetReducibleKw: '300.000',
      durationMin: 30,
      mechanisms: twoMechanisms,
    });
    expect(planFingerprint(split)).not.toBe(planFingerprint(PLAN));
  });

  it('is insensitive to allocation ordering', () => {
    const a: PlanMechanismInput[] = [
      { ...(MECHANISMS[0] as PlanMechanismInput), id: 'z', code: 'ZZZ', availableKw: '150.000' },
      { ...(MECHANISMS[0] as PlanMechanismInput), id: 'a', code: 'AAA', availableKw: '150.000' },
    ];
    const first = planReduction({ targetReducibleKw: '300.000', durationMin: 30, mechanisms: a });
    const second = planReduction({
      targetReducibleKw: '300.000',
      durationMin: 30,
      mechanisms: [...a].reverse(),
    });
    expect(planFingerprint(first)).toBe(planFingerprint(second));
  });
});

describe('applyResult — sequencing', () => {
  it('walks the happy path to COMPLETED', () => {
    let context = initialContext();
    expect(nextTool(context)).toBe('READ_TELEMETRY');

    context = applyResult(context, { tool: 'READ_TELEMETRY', succeeded: true });
    expect(nextTool(context)).toBe('FORECAST_FLEXIBILITY');

    context = applyResult(context, { tool: 'FORECAST_FLEXIBILITY', succeeded: true });
    expect(nextTool(context)).toBe('PLAN_REDUCTION');

    context = applyResult(context, { tool: 'PLAN_REDUCTION', succeeded: true, plan: PLAN });
    expect(nextTool(context)).toBe('ASSESS_RISK');

    context = applyResult(context, { tool: 'ASSESS_RISK', succeeded: true, risk: CLEAN_RISK });
    expect(nextTool(context)).toBe('REQUEST_APPROVAL');

    context = applyResult(context, {
      tool: 'REQUEST_APPROVAL',
      succeeded: true,
      approval: {
        grantedForPlanFingerprint: planFingerprint(PLAN),
        grantedBy: 'operator@example.com',
        grantedAt: '2026-07-21T12:00:00Z',
        consumed: false,
      },
    });
    expect(nextTool(context)).toBe('START_DRILL');
    expect(authorizeTool(context, 'START_DRILL').permitted).toBe(true);

    context = applyResult(context, { tool: 'START_DRILL', succeeded: true });
    expect(context.drillRunning).toBe(true);
    expect(nextTool(context)).toBe('MONITOR_DRILL');

    context = applyResult(context, { tool: 'MONITOR_DRILL', succeeded: true, drillFinished: false });
    expect(context.phase).toBe('RUNNING');

    context = applyResult(context, { tool: 'MONITOR_DRILL', succeeded: true, drillFinished: true });
    expect(nextTool(context)).toBe('VERIFY_DELIVERY');

    context = applyResult(context, { tool: 'VERIFY_DELIVERY', succeeded: true });
    expect(context.phase).toBe('COMPLETED');
    expect(nextTool(context)).toBeNull();
  });

  it('consumes the approval when the drill starts', () => {
    const context = applyResult(approvedContext(), { tool: 'START_DRILL', succeeded: true });
    expect(context.approval?.consumed).toBe(true);
    // A second start is now refused.
    expect(authorizeTool(context, 'START_DRILL').permitted).toBe(false);
  });

  it('CLEARS the approval when the plan is replaced', () => {
    // Belt and braces: the fingerprint check would also catch this, but two
    // independent mechanisms must both fail for an unreviewed plan to run.
    const context = applyResult(approvedContext(), {
      tool: 'PLAN_REDUCTION',
      succeeded: true,
      plan: PLAN,
    });
    expect(context.approval).toBeNull();
    expect(authorizeTool(context, 'START_DRILL').permitted).toBe(false);
  });

  it('refuses the session when risk assessment blocks', () => {
    const context = applyResult(
      { ...initialContext(), phase: 'ASSESSING' },
      { tool: 'ASSESS_RISK', succeeded: true, risk: BLOCKED_RISK },
    );
    expect(context.phase).toBe('REFUSED');
    expect(nextTool(context)).toBeNull();
  });

  it('aborts on STOP_DRILL from any phase', () => {
    for (const phase of ['RUNNING', 'APPROVED', 'AWAITING_APPROVAL'] as const) {
      const context = applyResult(approvedContext({ phase, drillRunning: true }), {
        tool: 'STOP_DRILL',
        succeeded: true,
      });
      expect(context.phase).toBe('ABORTED');
      expect(context.drillRunning).toBe(false);
    }
  });

  it('refuses the session when a tool fails', () => {
    const context = applyResult(approvedContext(), { tool: 'START_DRILL', succeeded: false });
    expect(context.phase).toBe('REFUSED');
  });

  it('prioritises stopping a running drill under emergency stop', () => {
    const context = approvedContext({
      phase: 'RUNNING',
      drillRunning: true,
      emergencyStopActive: true,
    });
    expect(nextTool(context)).toBe('STOP_DRILL');
  });

  it('is pure — the input context is not mutated', () => {
    // Contexts carry bigint power values, so the snapshot needs a bigint-aware
    // replacer; plain JSON.stringify throws on them.
    const serialize = (value: unknown): string =>
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'bigint' ? `${item}n` : item,
      );

    const context = approvedContext();
    const snapshot = serialize(context);
    applyResult(context, { tool: 'START_DRILL', succeeded: true });
    expect(serialize(context)).toBe(snapshot);
  });
});
