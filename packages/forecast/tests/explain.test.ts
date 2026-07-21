import { describe, expect, it } from 'vitest';
import { clampToEnvelope } from '../src/forecast/clamp.js';
import { planReduction, type PlanMechanismInput } from '../src/plan/index.js';
import { assessRisk } from '../src/risk/index.js';
import type { ForecastResult } from '../src/forecast/types.js';
import {
  DeterministicExplainer,
  assembleExplanationContext,
  buildExplanationPrompt,
  explainVerified,
  extractNumbers,
  normaliseNumber,
  validateGrounding,
  type Explainer,
} from '../src/explain/index.js';

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
  {
    id: 'm-cooling',
    code: 'COOLING_HEADROOM',
    mechanismType: 'COOLING',
    enabled: true,
    availableKw: '100.000',
    rampKwPerMin: '20.000',
    maximumDurationMin: 30,
    reboundWindowMin: 30,
  },
];

function forecastOf(overrides: Partial<ForecastResult> = {}): ForecastResult {
  return {
    modelVersion: 'test-1.0.0',
    status: 'OK',
    reducibleMkw: 700_000n,
    reducibleLowerMkw: 650_000n,
    reducibleUpperMkw: 750_000n,
    modelConfidence: 0.9,
    horizonMinutes: 30,
    completeness: 1,
    samplesUsed: 48,
    distinctDaysUsed: 7,
    intervalUnderpowered: false,
    refusals: [],
    warnings: [],
    ...overrides,
  };
}

function contextOf(options: { blocked?: boolean; durationMin?: number } = {}) {
  const claim = clampToEnvelope(forecastOf(), {
    status: 'DRAFT',
    totalReducibleKw: '450.000',
    confidenceScore: 0.25,
  });
  const plan = planReduction({
    targetReducibleKw: claim.claimedReducibleKw,
    durationMin: options.durationMin ?? 30,
    mechanisms: MECHANISMS,
  });
  const risk = assessRisk({
    plan,
    envelopeConfidence: 0.25,
    envelopeStatus: 'DRAFT',
    forecastIntervalUnderpowered: false,
    telemetryAgeSeconds: 60,
    telemetryCompleteness: 1,
    thermalMarginC: options.blocked === true ? 0.5 : 8,
    batteryStateOfCharge: 0.9,
    priorDrillCount: 4,
    priorDrillSuccessCount: 4,
    emergencyStopActive: false,
  });
  return assembleExplanationContext({ claim, plan, risk });
}

describe('numeric token handling', () => {
  it('extracts integers, decimals and grouped numbers', () => {
    expect(extractNumbers('450.000 kW over 30 min, 1,600 baseline')).toEqual([
      '450.000',
      '30',
      '1,600',
    ]);
  });

  it('normalises equivalent renderings to the same token', () => {
    expect(normaliseNumber('600.000')).toBe('600');
    expect(normaliseNumber('600.0')).toBe('600');
    expect(normaliseNumber('600')).toBe('600');
    expect(normaliseNumber('1,600')).toBe('1600');
  });

  it('preserves genuine precision', () => {
    expect(normaliseNumber('450.500')).toBe('450.5');
    expect(normaliseNumber('0.25')).toBe('0.25');
  });
});

describe('assembleExplanationContext', () => {
  it('collects the verified facts', () => {
    const context = contextOf();
    const keys = context.facts.map((f) => f.key);
    expect(keys).toContain('claimed_reduction_kw');
    expect(keys).toContain('claimed_confidence');
    expect(keys).toContain('risk_level');
    expect(keys).toContain('allocation_WORKLOAD_DEFERRAL');
  });

  it('permits the numbers that appear in verified values', () => {
    const context = contextOf();
    expect(context.allowedNumbers).toContain('450');
    expect(context.allowedNumbers).toContain('0.25');
    expect(context.allowedNumbers).toContain('30');
  });

  it('permits a percentage rendering of a verified fraction', () => {
    // 0.25 confidence may legitimately be written as "25%".
    expect(contextOf().allowedNumbers).toContain('25');
  });

  it('does NOT permit an arbitrary unrelated number', () => {
    expect(contextOf().allowedNumbers).not.toContain('94');
    expect(contextOf().allowedNumbers).not.toContain('9999');
  });
});

describe('validateGrounding — the enforcement point', () => {
  const context = contextOf();

  it('accepts text quoting only verified numbers', () => {
    const result = validateGrounding(
      'GridFlex recommends a 450.000 kW reduction for 30 minutes.',
      context,
    );
    expect(result.grounded).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('REJECTS a fabricated confidence figure', () => {
    // The headline hallucination: a confident-sounding number nobody computed,
    // dropped into a paragraph about a 0.25 assurance grade.
    const result = validateGrounding(
      'GridFlex can safely reduce 450.000 kW with 94% confidence.',
      context,
    );
    expect(result.grounded).toBe(false);
    expect(result.violations.some((v) => v.token === '94')).toBe(true);
  });

  it('rejects a fabricated power figure', () => {
    const result = validateGrounding('The facility can shed 1200 kW.', context);
    expect(result.grounded).toBe(false);
  });

  it('accepts equivalent renderings of a verified number', () => {
    // "450 kW" and "450.000 kW" are the same fact.
    expect(validateGrounding('A 450 kW reduction.', context).grounded).toBe(true);
  });

  it('permits small integers used as counts', () => {
    expect(validateGrounding('Both 2 mechanisms contribute.', context).grounded).toBe(true);
  });

  it('reports each fabricated number once', () => {
    const result = validateGrounding('We expect 94% then 94% again, plus 77.', context);
    expect(result.violations).toHaveLength(2);
  });

  it('accepts text with no numbers at all', () => {
    expect(validateGrounding('The plan is not recommended at this time.', context).grounded).toBe(true);
  });
});

describe('DeterministicExplainer', () => {
  it('produces a grounded explanation for a feasible plan', () => {
    const context = contextOf();
    const text = new DeterministicExplainer().explain(context);

    expect(text).toMatch(/recommends a 450.000 kW reduction for 30 minutes/);
    expect(validateGrounding(text, context).grounded).toBe(true);
  });

  it('names where the reduction comes from', () => {
    const text = new DeterministicExplainer().explain(contextOf());
    expect(text).toMatch(/350.000 kW from WORKLOAD_DEFERRAL/);
    expect(text).toMatch(/100.000 kW from COOLING_HEADROOM/);
  });

  it('states plainly that a blocked plan is not recommended', () => {
    const context = contextOf({ blocked: true });
    const text = new DeterministicExplainer().explain(context);

    expect(text).toMatch(/not recommending this drill/);
    expect(validateGrounding(text, context).grounded).toBe(true);
  });

  it('explains an infeasible plan with its shortfall', () => {
    // 60-min drill excludes the 30-min cooling mechanism.
    const context = contextOf({ durationMin: 60 });
    const text = new DeterministicExplainer().explain(context);

    expect(text).toMatch(/falls 100.000 kW short/);
    expect(text).toMatch(/COOLING_HEADROOM \(DURATION_EXCEEDS_MECHANISM_LIMIT\)/);
    expect(validateGrounding(text, context).grounded).toBe(true);
  });

  it('says when the envelope rather than the forecast bound the figure', () => {
    const text = new DeterministicExplainer().explain(contextOf());
    expect(text).toMatch(/capped by the assurance envelope/);
  });

  it('never claims capacity is guaranteed', () => {
    for (const options of [{}, { blocked: true }, { durationMin: 60 }]) {
      const text = new DeterministicExplainer().explain(contextOf(options));
      expect(text).not.toMatch(/guarantee|assured|certain to/i);
    }
  });

  it('is deterministic', () => {
    const context = contextOf();
    const explainer = new DeterministicExplainer();
    const first = explainer.explain(context);
    for (let i = 0; i < 3; i += 1) expect(explainer.explain(context)).toBe(first);
  });
});

describe('explainVerified — model output is policed', () => {
  const context = contextOf();

  it('returns model prose when it is grounded', async () => {
    const explainer: Explainer = {
      source: 'MODEL',
      explain: () => 'A 450.000 kW reduction is available for 30 minutes.',
    };
    const result = await explainVerified(context, explainer);

    expect(result.source).toBe('MODEL');
    expect(result.grounded).toBe(true);
  });

  it('DISCARDS hallucinated model prose and falls back to deterministic', async () => {
    // The operator gets a correct explanation, never a fabricated one and never
    // a blank space where an explanation should be.
    const explainer: Explainer = {
      source: 'MODEL',
      explain: () => 'GridFlex can deliver 1800 kW with 99% confidence.',
    };
    const result = await explainVerified(context, explainer);

    expect(result.source).toBe('DETERMINISTIC');
    expect(result.text).not.toMatch(/1800|99%/);
    expect(result.grounded).toBe(true);
    // The violation is retained so the failure is visible in the audit trail.
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('handles an async model explainer', async () => {
    const explainer: Explainer = {
      source: 'MODEL',
      explain: async () => Promise.resolve('Reduction of 450 kW over 30 minutes.'),
    };
    expect((await explainVerified(context, explainer)).grounded).toBe(true);
  });

  it('defaults to the deterministic explainer with no argument', async () => {
    const result = await explainVerified(context);
    expect(result.source).toBe('DETERMINISTIC');
    expect(result.grounded).toBe(true);
  });
});

describe('buildExplanationPrompt', () => {
  it('includes the verified facts', () => {
    const prompt = buildExplanationPrompt(contextOf());
    expect(prompt).toMatch(/Reduction claimed: 450.000/);
    expect(prompt).toMatch(/VERIFIED FACTS/);
  });

  it('instructs the model not to invent numbers', () => {
    const prompt = buildExplanationPrompt(contextOf());
    expect(prompt).toMatch(/Use ONLY the facts below/);
    expect(prompt).toMatch(/must appear verbatim/);
    expect(prompt).toMatch(/Do not claim capacity is guaranteed/);
  });
});
