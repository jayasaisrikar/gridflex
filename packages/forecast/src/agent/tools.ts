/**
 * The agent's tool surface.
 *
 * Every action the agent can take is declared here with its blast radius. The
 * declarations are data, not convention: the orchestrator reads them to decide
 * what is permitted in the current state, so adding a mutating tool without
 * marking it as such is a change to this table rather than an oversight
 * scattered through control flow.
 *
 * Two properties matter and are enforced by the orchestrator:
 *
 *   - `mutates`      — does this change facility or database state?
 *   - `requiresApproval` — must a human have approved THIS plan first?
 *
 * `STOP_DRILL` is deliberately mutating and deliberately NOT approval-gated. A
 * drill must always be stoppable, including before anyone has approved anything
 * and including while an approval is being waited on. Blocking a stop behind a
 * gate is the one failure this system must never have.
 */

export type ToolName =
  | 'READ_TELEMETRY'
  | 'READ_MECHANISMS'
  | 'READ_CONSTRAINTS'
  | 'READ_DRILL_HISTORY'
  | 'FORECAST_FLEXIBILITY'
  | 'PLAN_REDUCTION'
  | 'ASSESS_RISK'
  | 'SIMULATE_DRILL'
  | 'REQUEST_APPROVAL'
  | 'START_DRILL'
  | 'MONITOR_DRILL'
  | 'STOP_DRILL'
  | 'VERIFY_DELIVERY'
  | 'UPDATE_PASSPORT'
  | 'READ_GRID_SIGNALS'
  | 'EXPORT_CARBON_REPORT';

export interface ToolDefinition {
  readonly name: ToolName;
  /** Changes facility or database state. */
  readonly mutates: boolean;
  /** May only run after a human approval bound to the current plan. */
  readonly requiresApproval: boolean;
  readonly description: string;
}

export const TOOL_REGISTRY: Readonly<Record<ToolName, ToolDefinition>> = {
  READ_TELEMETRY: {
    name: 'READ_TELEMETRY',
    mutates: false,
    requiresApproval: false,
    description: 'Read facility telemetry for a window.',
  },
  READ_MECHANISMS: {
    name: 'READ_MECHANISMS',
    mutates: false,
    requiresApproval: false,
    description: 'Read configured flexibility mechanisms.',
  },
  READ_CONSTRAINTS: {
    name: 'READ_CONSTRAINTS',
    mutates: false,
    requiresApproval: false,
    description: 'Read facility safety constraints.',
  },
  READ_DRILL_HISTORY: {
    name: 'READ_DRILL_HISTORY',
    mutates: false,
    requiresApproval: false,
    description: 'Read prior drill outcomes.',
  },
  FORECAST_FLEXIBILITY: {
    name: 'FORECAST_FLEXIBILITY',
    mutates: false,
    requiresApproval: false,
    description: 'Predict safely reducible capacity, clamped to the envelope.',
  },
  PLAN_REDUCTION: {
    name: 'PLAN_REDUCTION',
    mutates: false,
    requiresApproval: false,
    description: 'Allocate the reduction across mechanisms.',
  },
  ASSESS_RISK: {
    name: 'ASSESS_RISK',
    mutates: false,
    requiresApproval: false,
    description: 'Run deterministic risk checks against the plan.',
  },
  SIMULATE_DRILL: {
    name: 'SIMULATE_DRILL',
    mutates: false,
    requiresApproval: false,
    description: 'Run the plan through the digital twin.',
  },
  REQUEST_APPROVAL: {
    name: 'REQUEST_APPROVAL',
    mutates: true,
    requiresApproval: false,
    description: 'Record an approval request for an operator. Creates no facility change.',
  },
  START_DRILL: {
    name: 'START_DRILL',
    mutates: true,
    requiresApproval: true,
    description: 'Begin the approved drill via the connector or simulator.',
  },
  MONITOR_DRILL: {
    name: 'MONITOR_DRILL',
    mutates: false,
    requiresApproval: false,
    description: 'Sample live telemetry during a running drill.',
  },
  STOP_DRILL: {
    name: 'STOP_DRILL',
    mutates: true,
    // Never gated. A running drill must always be stoppable.
    requiresApproval: false,
    description: 'Halt a running drill immediately.',
  },
  VERIFY_DELIVERY: {
    name: 'VERIFY_DELIVERY',
    mutates: false,
    requiresApproval: false,
    description: 'Compute delivered reduction via the deterministic MRV engine.',
  },
  UPDATE_PASSPORT: {
    name: 'UPDATE_PASSPORT',
    mutates: true,
    requiresApproval: true,
    description: 'Write the verified outcome into the GridFlex Proof.',
  },
  READ_GRID_SIGNALS: {
    name: 'READ_GRID_SIGNALS',
    mutates: false,
    requiresApproval: false,
    description:
      'Read grid signals: DEWA peak window, temperature and carbon-intensity forecast.',
  },
  EXPORT_CARBON_REPORT: {
    name: 'EXPORT_CARBON_REPORT',
    mutates: true,
    requiresApproval: false,
    description: 'Export the sealed Scope 2 carbon report for the verified event.',
  },
};

/** Tools that may run at any time, including while stopping or blocked. */
export const ALWAYS_PERMITTED: readonly ToolName[] = ['STOP_DRILL'];

export function isMutating(name: ToolName): boolean {
  return TOOL_REGISTRY[name].mutates;
}

export function requiresApproval(name: ToolName): boolean {
  return TOOL_REGISTRY[name].requiresApproval;
}
