import { describe, expect, it } from 'vitest';
import {
  checkPlanAgainstLimits,
  evaluateTransition,
  isTerminal,
  LIVE_STATUSES,
  TERMINAL_STATUSES,
  type DrillAction,
  type DrillStatus,
  type FacilityLimits,
  type SafetyContext,
} from '../src/drill/state-machine.js';

const safeContext: SafetyContext = {
  emergencyStopActive: false,
  anotherDrillLive: false,
  telemetryStale: false,
  telemetryCompleteness: 1,
  thermalLimitExceeded: false,
  envelopeCurrent: true,
};

/** Canonical facility limits from gridflex_seed.sql. */
const limits: FacilityLimits = {
  normalLoadKw: 1600,
  minimumSafeLoadKw: 900,
  maximumCurtailmentKw: 600,
  maximumRampKwPerMin: 100,
  maximumDurationMin: 60,
  envelopeReducibleKw: 600,
};

const validPlan = { requestedReductionKw: 500, durationMin: 30, rampKwPerMin: 100 };

function transition(status: DrillStatus, action: DrillAction, safety = safeContext) {
  return evaluateTransition({ currentStatus: status, action, safety, plan: validPlan, limits });
}

describe('allowed transitions (spec 13)', () => {
  it('walks the happy path DRAFT -> READY -> ARMED -> RUNNING -> VERIFYING -> COMPLETED', () => {
    expect(transition('DRAFT', 'VALIDATE')).toMatchObject({ allowed: true, nextStatus: 'READY' });
    expect(transition('READY', 'ARM')).toMatchObject({ allowed: true, nextStatus: 'ARMED' });
    expect(transition('ARMED', 'START')).toMatchObject({ allowed: true, nextStatus: 'RUNNING' });
    expect(transition('RUNNING', 'COMPLETE')).toMatchObject({
      allowed: true,
      nextStatus: 'VERIFYING',
    });
    expect(transition('VERIFYING', 'VERIFY')).toMatchObject({
      allowed: true,
      nextStatus: 'COMPLETED',
    });
  });

  it('allows cancellation from pre-execution states only', () => {
    expect(transition('DRAFT', 'CANCEL').allowed).toBe(true);
    expect(transition('READY', 'CANCEL').allowed).toBe(true);
    expect(transition('ARMED', 'CANCEL').allowed).toBe(true);
    // Once RUNNING, the way out is ABORT — which is recorded differently.
    expect(transition('RUNNING', 'CANCEL').allowed).toBe(false);
  });

  it('allows abort from ARMED and RUNNING', () => {
    expect(transition('ARMED', 'ABORT')).toMatchObject({ allowed: true, nextStatus: 'ABORTED' });
    expect(transition('RUNNING', 'ABORT')).toMatchObject({ allowed: true, nextStatus: 'ABORTED' });
  });
});

describe('forbidden transitions', () => {
  it('refuses to skip arming', () => {
    const result = transition('READY', 'START');
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.refusals[0]?.code).toBe('DRILL_INVALID_TRANSITION');
  });

  it('refuses to arm straight from DRAFT without validation', () => {
    expect(transition('DRAFT', 'ARM').allowed).toBe(false);
  });

  it('treats terminal states as final for every action', () => {
    const actions: DrillAction[] = ['VALIDATE', 'ARM', 'START', 'COMPLETE', 'VERIFY', 'ABORT', 'CANCEL', 'FAIL'];
    for (const status of TERMINAL_STATUSES) {
      for (const action of actions) {
        expect(transition(status, action).allowed, `${status} + ${action}`).toBe(false);
      }
    }
  });

  it('reports terminal and live status sets consistently', () => {
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('RUNNING')).toBe(false);
    for (const status of LIVE_STATUSES) expect(isTerminal(status)).toBe(false);
  });
});

describe('emergency stop preemption (spec 13.1)', () => {
  const stopped: SafetyContext = { ...safeContext, emergencyStopActive: true };

  it('blocks arming and starting', () => {
    for (const [status, action] of [
      ['READY', 'ARM'],
      ['ARMED', 'START'],
    ] as const) {
      const result = evaluateTransition({
        currentStatus: status,
        action,
        safety: stopped,
        plan: validPlan,
        limits,
      });
      expect(result.allowed).toBe(false);
      expect(
        result.allowed === false && result.refusals.some((r) => r.code === 'EMERGENCY_STOP_ACTIVE'),
      ).toBe(true);
    }
  });

  it('still permits abort so a live drill can always be brought down', () => {
    // This is the critical safety property: an emergency stop must never trap a
    // running drill in an unstoppable state.
    expect(
      evaluateTransition({ currentStatus: 'RUNNING', action: 'ABORT', safety: stopped }).allowed,
    ).toBe(true);
    expect(
      evaluateTransition({ currentStatus: 'RUNNING', action: 'FAIL', safety: stopped }).allowed,
    ).toBe(true);
    expect(
      evaluateTransition({ currentStatus: 'ARMED', action: 'CANCEL', safety: stopped }).allowed,
    ).toBe(true);
  });
});

describe('safety gates on arming (spec 10.2, 13.1)', () => {
  const armWith = (safety: Partial<SafetyContext>) =>
    evaluateTransition({
      currentStatus: 'READY',
      action: 'ARM',
      safety: { ...safeContext, ...safety },
      plan: validPlan,
      limits,
    });

  it('blocks arming when telemetry is stale', () => {
    const result = armWith({ telemetryStale: true });
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.refusals.some((r) => r.code === 'TELEMETRY_STALE')).toBe(true);
  });

  it('blocks arming below 90% completeness', () => {
    expect(armWith({ telemetryCompleteness: 0.89 }).allowed).toBe(false);
    expect(armWith({ telemetryCompleteness: 0.9 }).allowed).toBe(true);
  });

  it('blocks arming when another drill is live (one live drill per facility)', () => {
    const result = armWith({ anotherDrillLive: true });
    expect(result.allowed === false && result.refusals.some((r) => r.code === 'DRILL_ALREADY_LIVE')).toBe(true);
  });

  it('blocks arming on thermal violation', () => {
    const result = armWith({ thermalLimitExceeded: true });
    expect(result.allowed === false && result.refusals.some((r) => r.code === 'THERMAL_LIMIT_EXCEEDED')).toBe(true);
  });

  it('blocks arming without a current envelope', () => {
    const result = armWith({ envelopeCurrent: false });
    expect(result.allowed === false && result.refusals.some((r) => r.code === 'ENVELOPE_NOT_CURRENT')).toBe(true);
  });

  it('returns every applicable refusal at once, not just the first', () => {
    const result = armWith({
      telemetryStale: true,
      thermalLimitExceeded: true,
      anotherDrillLive: true,
    });
    expect(result.allowed).toBe(false);
    const codes = result.allowed === false ? result.refusals.map((r) => r.code) : [];
    expect(codes).toContain('TELEMETRY_STALE');
    expect(codes).toContain('THERMAL_LIMIT_EXCEEDED');
    expect(codes).toContain('DRILL_ALREADY_LIVE');
  });
});

describe('plan safety invariants (spec 13.1)', () => {
  it('accepts the canonical 500 kW / 30 min plan', () => {
    expect(checkPlanAgainstLimits(validPlan, limits)).toEqual([]);
  });

  it('refuses a reduction that would breach the minimum safe load', () => {
    // 1600 - 750 = 850 kW, below the 900 kW floor.
    const refusals = checkPlanAgainstLimits({ ...validPlan, requestedReductionKw: 750 }, limits);
    expect(refusals.some((r) => r.code === 'DRILL_BELOW_MINIMUM_SAFE_LOAD')).toBe(true);
  });

  it('refuses a reduction beyond maximum curtailment', () => {
    const refusals = checkPlanAgainstLimits({ ...validPlan, requestedReductionKw: 601 }, limits);
    expect(refusals.some((r) => r.code === 'DRILL_EXCEEDS_ENVELOPE')).toBe(true);
  });

  it('refuses a reduction beyond the current envelope', () => {
    const refusals = checkPlanAgainstLimits(
      { ...validPlan, requestedReductionKw: 500 },
      { ...limits, envelopeReducibleKw: 400 },
    );
    expect(refusals.some((r) => r.code === 'DRILL_EXCEEDS_ENVELOPE')).toBe(true);
  });

  it('refuses a ramp beyond the configured maximum', () => {
    const refusals = checkPlanAgainstLimits({ ...validPlan, rampKwPerMin: 101 }, limits);
    expect(refusals.some((r) => r.code === 'DRILL_EXCEEDS_RAMP_LIMIT')).toBe(true);
  });

  it('refuses a duration beyond the configured maximum', () => {
    const refusals = checkPlanAgainstLimits({ ...validPlan, durationMin: 61 }, limits);
    expect(refusals.some((r) => r.code === 'DRILL_EXCEEDS_MAX_DURATION')).toBe(true);
  });

  it('accepts a plan sitting exactly on every boundary', () => {
    // 1600 - 700 = 900 kW == the floor exactly; 600 kW cap; 100 kW/min; 60 min.
    expect(
      checkPlanAgainstLimits(
        { requestedReductionKw: 600, durationMin: 60, rampKwPerMin: 100 },
        { ...limits, minimumSafeLoadKw: 1000 },
      ),
    ).toEqual([]);
  });
});
