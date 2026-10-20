/**
 * LLM planner harness.
 *
 * The agent loop the Product & Build Doc calls P0: a language model proposes
 * tool calls, and every proposal passes through the deterministic
 * `authorizeTool` gate before any executor runs it. The model never sees a
 * database, a credential, or a way to act; it can only ask, and the same four
 * orchestrator invariants that bind a scripted caller bind it:
 *
 *   1. A mutating tool cannot run without a live approval bound to the
 *      CURRENT plan.
 *   2. An approval is single-use and plan-bound.
 *   3. STOP_DRILL is always authorized.
 *   4. A latched emergency stop refuses everything except stopping.
 *
 * The model talks to the harness through a `ModelClient` — a minimal
 * OpenAI-compatible chat interface carried over HTTP fetch, so no SDK
 * dependency enters the assurance path. Any provider that speaks that shape
 * works; tests inject a fake.
 *
 * Refusals are fed back to the model as tool results rather than exceptions:
 * a planner that proposed something the facility forbids should get the same
 * answer a human operator would — what was refused and why. A refusal the
 * orchestrator has latched (terminal session, emergency stop) ends the loop;
 * a plan-level refusal (approval required, plan mismatch) is returned to the
 * model once so it can correct course, up to the step budget.
 *
 * When no model is configured, callers fall back to the deterministic
 * `nextTool` sequencing — the harness is additive, never a replacement for
 * the explainable path.
 */

import {
  applyResult,
  authorizeTool,
  planFingerprint,
  type AgentContext,
} from './orchestrator.js';
import type { ReductionPlan } from '../plan/index.js';
import type { RiskAssessment } from '../risk/index.js';
import { TOOL_REGISTRY, type ToolName } from './tools.js';

export const PLANNER_HARNESS_VERSION = 'gridflex-llm-harness-1.0.0';

/** Default cap on model turns per session. A runaway loop cannot outspend it. */
export const MAX_STEPS = 12;

/** Tools the model may propose. Terminal bookkeeping stays deterministic. */
const MODEL_PROPOSABLE: readonly ToolName[] = (
  Object.keys(TOOL_REGISTRY) as ToolName[]
).filter((name) => name !== 'REQUEST_APPROVAL');

const SYSTEM_PROMPT = [
  'You are the GridFlex flexibility agent for a data centre.',
  'You propose exactly one tool call per turn from the provided tool list.',
  'You never compute certified numbers: forecasts, plans, risk verdicts, MRV',
  'results and carbon figures are produced by deterministic code. Your reasons',
  'and narrative must only restate values returned by tools.',
  'When the peak window is near, plan with cooling-first priority.',
  'If a call is refused, read the refusal codes, adjust, and try again within',
  'your remaining turns. When verification is complete, stop calling tools.',
].join(' ');

export interface ModelToolCall {
  readonly name: ToolName;
  readonly arguments: Record<string, unknown>;
}

export interface ModelChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  /** Present on assistant messages that proposed a tool call. */
  readonly toolCall?: ModelToolCall;
}

/** Minimal OpenAI-compatible chat client. Implemented over fetch, no SDK. */
export interface ModelClient {
  complete(messages: readonly ModelChatMessage[]): Promise<{
    message: ModelChatMessage;
    /** Raw token usage for the audit trail, when the provider reports it. */
    usage?: { readonly inputTokens: number; readonly outputTokens: number };
  }>;
}

export interface HarnessSessionConfig {
  readonly model: ModelClient;
  readonly maxSteps?: number;
  /**
   * Records an operator approval for the CURRENT plan. Invoked once when the
   * session reaches AWAITING_APPROVAL. The model can never call it — approvals
   * are human acts; the harness only books them into the state machine so the
   * deterministic `REQUEST_APPROVAL` phase still advances.
   */
  readonly grantApproval?: (
    planFingerprint: string,
  ) => Promise<{ grantedBy: string; grantedAt: string }>;
}

export interface HarnessStep {
  readonly step: number;
  readonly proposed: ModelToolCall;
  readonly authorized: boolean;
  readonly refusalCodes: readonly string[];
  /** Narrative the model produced alongside the proposal. */
  readonly reasoning: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface HarnessOutcome {
  readonly status: 'COMPLETED' | 'REFUSED' | 'ABORTED' | 'STEP_BUDGET_EXHAUSTED';
  readonly steps: readonly HarnessStep[];
  readonly context: AgentContext;
  readonly totalUsage: { inputTokens: number; outputTokens: number };
}

/** Errors from an executor, normalized so they can feed back to the model. */
export type ToolExecutor = (
  tool: ToolName,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export class HarnessError extends Error {
  public readonly code = 'HARNESS_INVALID_STATE';
  constructor(message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

function refusalIsTerminal(code: string): boolean {
  return (
    code === 'SESSION_TERMINAL' ||
    code === 'EMERGENCY_STOP_ACTIVE' ||
    code === 'APPROVAL_ALREADY_CONSUMED'
  );
}

function summarizeRefusals(refusals: readonly { code: string; detail: string }[]): string {
  return refusals.map((r) => `${r.code}: ${r.detail}`).join(' | ');
}

/**
 * Runs one model-driven agent session to a terminal or budgeted end.
 *
 * `context` enters as the current orchestrator state and is advanced only by
 * `applyResult` after an authorized executor run — the harness cannot invent
 * phase transitions. A proposal that fails authorization never reaches the
 * executor, produces no state change, and is reported back to the model.
 */
export async function runAgentSession(input: {
  readonly config: HarnessSessionConfig;
  readonly initialContext: AgentContext;
  readonly executor: ToolExecutor;
  /** Brief situation text shown to the model at the start of the session. */
  readonly situation: string;
}): Promise<HarnessOutcome> {
  const { config, executor } = input;
  const maxSteps = config.maxSteps ?? MAX_STEPS;
  const messages: ModelChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: input.situation },
  ];

  let context = input.initialContext;
  const steps: HarnessStep[] = [];
  const totalUsage = { inputTokens: 0, outputTokens: 0 };
  let status: HarnessOutcome['status'] = 'STEP_BUDGET_EXHAUSTED';

  for (let step = 1; step <= maxSteps; step += 1) {
    const completion = await config.model.complete(messages);
    const proposal = completion.message.toolCall;
    if (completion.message.role !== 'assistant' || proposal === undefined) {
      throw new HarnessError('Model returned no tool call; the harness requires one per turn');
    }
    if (!MODEL_PROPOSABLE.includes(proposal.name)) {
      throw new HarnessError(`Model proposed non-proposable tool ${proposal.name}`);
    }
    totalUsage.inputTokens += completion.usage?.inputTokens ?? 0;
    totalUsage.outputTokens += completion.usage?.outputTokens ?? 0;

    const authorization = authorizeTool(context, proposal.name);
    if (!authorization.permitted) {
      const codes = authorization.refusals.map((r) => r.code);
      steps.push({
        step,
        proposed: proposal,
        authorized: false,
        refusalCodes: codes,
        reasoning: completion.message.content,
        ...(completion.usage ? { usage: completion.usage } : {}),
      });
      if (codes.some(refusalIsTerminal)) {
        status = 'REFUSED';
        break;
      }
      messages.push({
        role: 'assistant',
        content: completion.message.content,
        toolCall: proposal,
      });
      messages.push({
        role: 'tool',
        content: summarizeRefusals(authorization.refusals),
      });
      continue;
    }

    // Authorized: the executor runs it, and its observation is what the next
    // model turn sees. Executor errors are refusals for the model's purposes —
    // they never crash the session, and they carry no database internals.
    let observation: Record<string, unknown>;
    let succeeded = true;
    try {
      observation = await executor(proposal.name, proposal.arguments);
    } catch (error) {
      succeeded = false;
      observation = {
        error:
          error instanceof Error
            ? `Tool ${proposal.name} failed: ${error.name}`
            : `Tool ${proposal.name} failed`,
      };
    }

    steps.push({
      step,
      proposed: proposal,
      authorized: true,
      refusalCodes: [],
      reasoning: completion.message.content,
      ...(completion.usage ? { usage: completion.usage } : {}),
    });

    const phaseBefore = context.phase;
    context = applyResult(context, {
      tool: proposal.name,
      succeeded,
      ...(observation.plan !== undefined ? { plan: observation.plan as ReductionPlan } : {}),
      ...(observation.risk !== undefined ? { risk: observation.risk as RiskAssessment } : {}),
      ...(typeof observation.drillFinished === 'boolean'
        ? { drillFinished: observation.drillFinished }
        : {}),
    });

    // The one human step in the loop. When the state machine is waiting on an
    // operator and a grant hook is configured, the harness records the
    // approval against the exact plan fingerprint in state. Without the hook
    // the session simply parks in AWAITING_APPROVAL — safe by default.
    if (
      context.phase === 'AWAITING_APPROVAL' &&
      config.grantApproval !== undefined &&
      context.plan !== null
    ) {
      const grant = await config.grantApproval(planFingerprint(context.plan));
      context = applyResult(context, {
        tool: 'REQUEST_APPROVAL',
        succeeded: true,
        approval: {
          grantedForPlanFingerprint: planFingerprint(context.plan),
          grantedBy: grant.grantedBy,
          grantedAt: grant.grantedAt,
          consumed: false,
        },
      });
    }

    messages.push({
      role: 'assistant',
      content: completion.message.content,
      toolCall: proposal,
    });
    /** Anything JSON-incompatible (BigInt) degrades to a tagged string. */
    const serializable = JSON.parse(
      JSON.stringify(observation, (_key, value) =>
        typeof value === 'bigint' ? `${value}n` : value instanceof Map ? Object.fromEntries(value) : value,
      ),
    ) as Record<string, unknown>;

    messages.push({
      role: 'tool',
      content: JSON.stringify({
        tool: proposal.name,
        executed: true,
        phase: context.phase,
        changed: context.phase !== phaseBefore,
        observation: serializable,
      }),
    });


    if (
      context.phase === 'COMPLETED' ||
      context.phase === 'REFUSED' ||
      context.phase === 'ABORTED'
    ) {
      status =
        context.phase === 'COMPLETED' ? 'COMPLETED' : context.phase === 'ABORTED' ? 'ABORTED' : 'REFUSED';
      break;
    }
  }

  return { status, steps, context, totalUsage };
}

/** Re-derives the plan fingerprint an approval must match. */
export function fingerprintFor(context: AgentContext): string | null {
  return context.plan === null ? null : planFingerprint(context.plan);
}
