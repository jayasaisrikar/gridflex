import { describe, expect, it } from 'vitest';
import {
  MAX_STEPS,
  PLANNER_HARNESS_VERSION,
  runAgentSession,
  type ModelChatMessage,
  type ModelClient,
} from '../src/agent/harness.js';
import { initialContext, planFingerprint } from '../src/agent/orchestrator.js';
import type { ToolName } from '../src/agent/tools.js';
import { planReduction, type PlanMechanismInput } from '../src/plan/index.js';
import { assessRisk } from '../src/risk/index.js';

const MECHANISMS: PlanMechanismInput[] = [
  {
    id: 'm-cooling',
    code: 'COOLING_SETPOINT_SHIFT',
    mechanismType: 'COOLING',
    enabled: true,
    availableKw: '300.000',
    rampKwPerMin: '40.000',
    maximumDurationMin: 60,
    reboundWindowMin: 30,
  },
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
  priority: 'COOLING_FIRST',
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

function assistant(content: string, name: ToolName): ModelChatMessage {
  return { role: 'assistant', content, toolCall: { name, arguments: {} } };
}

/** Scripted model: pops one prepared response per call. */
function scriptedModel(responses: ModelChatMessage[]): ModelClient & { calls: number } {
  let index = 0;
  return {
    calls: 0,
    async complete() {
      const message = responses[index];
      index += 1;
      this.calls += 1;
      if (message === undefined) {
        throw new Error('Scripted model exhausted');
      }
      return { message, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

/** Executor that advances the workflow exactly like the scripted pipeline. */
function scriptedExecutor(options: { drillFinishes?: boolean } = {}) {
  return async (tool: ToolName) => {
    switch (tool) {
      case 'READ_TELEMETRY':
        return { telemetryAgeSeconds: 60 };
      case 'FORECAST_FLEXIBILITY':
        return { forecast: true };
      case 'PLAN_REDUCTION':
        return { plan: PLAN };
      case 'ASSESS_RISK':
        return { risk: CLEAN_RISK };
      case 'REQUEST_APPROVAL':
        return {};
      case 'START_DRILL':
        return { started: true };
      case 'MONITOR_DRILL':
        return { drillFinished: options.drillFinishes ?? true };
      case 'VERIFY_DELIVERY':
        return { deliveredKw: '297.500' };
      default:
        return {};
    }
  };
}

/** Context advanced by the executor's PLAN_REDUCTION result. */
function planningContext() {
  let context = initialContext();
  context = {
    ...context,
    phase: 'PLANNING',
  };
  return context;
}

describe('LLM planner harness', () => {
  it('declares its version and default budget', () => {
    expect(PLANNER_HARNESS_VERSION).toBe('gridflex-llm-harness-1.0.0');
    expect(MAX_STEPS).toBeGreaterThan(0);
  });

  it('runs an authorized session to completion through the gate', async () => {
    const model = scriptedModel([
      assistant('reading telemetry', 'READ_TELEMETRY'),
      assistant('forecasting', 'FORECAST_FLEXIBILITY'),
      assistant('planning', 'PLAN_REDUCTION'),
      assistant('assessing', 'ASSESS_RISK'),
      assistant('starting', 'START_DRILL'),
      assistant('monitoring', 'MONITOR_DRILL'),
      assistant('verifying', 'VERIFY_DELIVERY'),
    ]);

    const approvedFingerprints: string[] = [];
    const outcome = await runAgentSession({
      config: {
        model,
        grantApproval: async (fingerprint) => {
          approvedFingerprints.push(fingerprint);
          return { grantedBy: 'operator@example.com', grantedAt: '2026-08-15T08:10:00Z' };
        },
      },
      initialContext: planningContext(),
      executor: scriptedExecutor(),
      situation: 'Peak window in 3 hours.',
    });

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.steps.every((step) => step.authorized)).toBe(true);
    expect(approvedFingerprints).toEqual([planFingerprint(PLAN)]);
    expect(outcome.context.phase).toBe('COMPLETED');
    expect(outcome.totalUsage).toEqual({ inputTokens: 70, outputTokens: 35 });
  });

  it('parks safely in AWAITING_APPROVAL when no grant hook is configured', async () => {
    const model = scriptedModel([
      assistant('reading telemetry', 'READ_TELEMETRY'),
      assistant('forecasting', 'FORECAST_FLEXIBILITY'),
      assistant('planning', 'PLAN_REDUCTION'),
      assistant('assessing', 'ASSESS_RISK'),
      ...Array.from({ length: 8 }, (_, i) =>
        assistant(`checking again ${i + 1}`, 'MONITOR_DRILL'),
      ),
    ]);

    const outcome = await runAgentSession({
      config: { model, maxSteps: 12 },
      initialContext: planningContext(),
      executor: scriptedExecutor({ drillFinishes: false }),
      situation: 'Peak window in 3 hours.',
    });

    // Without a hook the session cannot proceed past the approval gate: the
    // workflow reads stay authorized but the phase never leaves
    // AWAITING_APPROVAL, and the budget runs out with the plan intact.
    expect(outcome.status).toBe('STEP_BUDGET_EXHAUSTED');
    expect(outcome.context.phase).toBe('AWAITING_APPROVAL');
    expect(outcome.context.plan?.allocatedKw).toBe(PLAN.allocatedKw);
    expect(outcome.steps).toHaveLength(12);
  });

  it('feeds a refusal back to the model without executing anything', async () => {
    // Session sits in PLANNING: proposed START_DRILL needs an approval. The
    // model adjusts, tries the same gate again, then falls back to planning.
    const model = scriptedModel([
      assistant('jumping straight to start', 'START_DRILL'),
      assistant('retrying the start', 'START_DRILL'),
      assistant('planning instead', 'PLAN_REDUCTION'),
      assistant('assessing', 'ASSESS_RISK'),
      ...Array.from({ length: 8 }, (_, i) =>
        assistant(`checking again ${i + 1}`, 'MONITOR_DRILL'),
      ),
    ]);

    const outcome = await runAgentSession({
      config: { model, maxSteps: 12 },
      initialContext: planningContext(),
      executor: scriptedExecutor({ drillFinishes: false }),
      situation: 'Peak window in 3 hours.',
    });

    expect(outcome.status).toBe('STEP_BUDGET_EXHAUSTED');
    expect(outcome.steps[0]?.authorized).toBe(false);
    expect(outcome.steps[0]?.refusalCodes).toContain('APPROVAL_REQUIRED');
    expect(outcome.steps[1]?.authorized).toBe(false);
    expect(outcome.steps[2]?.authorized).toBe(true);
    expect(outcome.context.phase).toBe('AWAITING_APPROVAL');
  });

  it('ends the session immediately when a terminal refusal latches', async () => {
    const model = scriptedModel([assistant('trying to act', 'START_DRILL')]);

    const outcome = await runAgentSession({
      config: { model },
      initialContext: {
        ...initialContext(),
        phase: 'RUNNING',
        plan: PLAN,
        risk: CLEAN_RISK,
        emergencyStopActive: true,
        drillRunning: true,
      },
      executor: scriptedExecutor(),
      situation: 'Emergency stop is latched.',
    });

    expect(outcome.status).toBe('REFUSED');
    expect(outcome.steps).toHaveLength(1);
    expect(outcome.steps[0]?.refusalCodes).toContain('EMERGENCY_STOP_ACTIVE');
  });

  it('allows STOP_DRILL even under a latched emergency stop', async () => {
    const model = scriptedModel([assistant('stopping everything', 'STOP_DRILL')]);

    const outcome = await runAgentSession({
      config: { model },
      initialContext: {
        ...initialContext(),
        phase: 'RUNNING',
        emergencyStopActive: true,
        drillRunning: true,
      },
      executor: scriptedExecutor(),
      situation: 'Emergency stop is latched.',
    });

    expect(outcome.status).toBe('ABORTED');
    expect(outcome.steps[0]?.authorized).toBe(true);
  });

  it('rejects a model that stops proposing tool calls', async () => {
    const model: ModelClient = {
      async complete() {
        return { message: { role: 'assistant', content: 'just chatting' } };
      },
    };

    await expect(
      runAgentSession({
        config: { model },
        initialContext: planningContext(),
        executor: scriptedExecutor(),
        situation: 'x',
      }),
    ).rejects.toMatchObject({ code: 'HARNESS_INVALID_STATE' });
  });

  it('rejects proposals for tools the model may not call', async () => {
    const model = scriptedModel([{ role: 'assistant', content: 'x', toolCall: { name: 'REQUEST_APPROVAL', arguments: {} } }]);

    await expect(
      runAgentSession({
        config: { model },
        initialContext: planningContext(),
        executor: scriptedExecutor(),
        situation: 'x',
      }),
    ).rejects.toMatchObject({ code: 'HARNESS_INVALID_STATE' });
  });

  it('turns executor errors into observations, not crashes', async () => {
    const model = scriptedModel([
      assistant('reading telemetry', 'READ_TELEMETRY'),
    ]);
    const executor = async () => {
      throw new Error('connection refused');
    };

    const outcome = await runAgentSession({
      config: { model },
      initialContext: planningContext(),
      executor,
      situation: 'x',
    });

    expect(outcome.steps[0]?.authorized).toBe(true);
    // applyResult marks a failed step REFUSED.
    expect(outcome.status).toBe('REFUSED');
  });

  it('keeps the approval fingerprint stable for the plan the operator saw', async () => {
    expect(planFingerprint(PLAN)).toContain('m-cooling=300.000');
  });
});
