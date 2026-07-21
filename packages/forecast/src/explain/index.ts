/**
 * Explanation layer.
 *
 * Turns verified results into prose an operator can act on. The governing rule
 * is that the official numbers come from deterministic code and the explanation
 * layer may only restate them — it never computes, estimates, or infers a value.
 *
 * That rule is enforced, not merely stated. `assembleExplanationContext` gathers
 * the verified facts and the exact set of numeric tokens permitted to appear in
 * any explanation of them. `validateGrounding` then checks a candidate
 * explanation and rejects it if it contains a number that is not in that set.
 * An LLM that hallucinates "we are 94% confident" into a paragraph about a 25%
 * assurance grade fails the check and the explanation is not shown.
 *
 * The default explainer is deterministic and needs no model or API key. A
 * model-backed explainer is an optional implementation of `Explainer`, and it is
 * subject to exactly the same grounding check.
 */
import type { ClampedClaim } from '../forecast/clamp.js';
import type { ReductionPlan } from '../plan/index.js';
import type { RiskAssessment } from '../risk/index.js';
import type { Anomaly } from '../anomaly/index.js';

export const EXPLAINER_VERSION = 'gridflex-explain-1.0.0';

export interface ExplanationFact {
  readonly key: string;
  readonly value: string;
  readonly label: string;
}

export interface ExplanationContext {
  /** Verified facts, each already rendered as the exact string to be quoted. */
  readonly facts: readonly ExplanationFact[];
  /** Every numeric token permitted to appear in an explanation of these facts. */
  readonly allowedNumbers: readonly string[];
  readonly claim: ClampedClaim;
  readonly plan: ReductionPlan;
  readonly risk: RiskAssessment;
  readonly anomalies: readonly Anomaly[];
}

export interface GroundingViolation {
  readonly token: string;
  readonly reason: string;
}

export interface GroundingResult {
  readonly grounded: boolean;
  readonly violations: readonly GroundingViolation[];
}

export interface Explanation {
  readonly explainerVersion: string;
  readonly text: string;
  readonly grounded: boolean;
  readonly violations: readonly GroundingViolation[];
  /** Source of the prose, for attribution in the audit trail. */
  readonly source: 'DETERMINISTIC' | 'MODEL';
}

export interface Explainer {
  readonly source: 'DETERMINISTIC' | 'MODEL';
  explain(context: ExplanationContext): Promise<string> | string;
}

/**
 * Numbers that carry no factual claim and are therefore always permitted.
 * Small integers appear in ordinary prose ("all 3 mechanisms", "the 2 blockers")
 * where they are counts of things the reader can see listed.
 */
const ALWAYS_ALLOWED = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);

/** Extracts numeric tokens, including decimals and percentages. */
export function extractNumbers(text: string): readonly string[] {
  return text.match(/\d+(?:[.,]\d+)*/g) ?? [];
}

/** Normalises a numeric token so "600.000", "600.0" and "600" compare equal. */
export function normaliseNumber(token: string): string {
  const cleaned = token.replace(/,/g, '');
  if (!cleaned.includes('.')) return cleaned;
  const trimmed = cleaned.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}

export function assembleExplanationContext(input: {
  readonly claim: ClampedClaim;
  readonly plan: ReductionPlan;
  readonly risk: RiskAssessment;
  readonly anomalies?: readonly Anomaly[];
}): ExplanationContext {
  const { claim, plan, risk } = input;
  const anomalies = input.anomalies ?? [];

  const facts: ExplanationFact[] = [
    { key: 'claimed_reduction_kw', value: claim.claimedReducibleKw, label: 'Reduction claimed' },
    {
      key: 'claimed_confidence',
      value: claim.claimedConfidence.toString(),
      label: 'Assurance-bounded confidence',
    },
    { key: 'binding_side', value: claim.bindingSide, label: 'Which layer bound the claim' },
    { key: 'horizon_minutes', value: claim.horizonMinutes.toString(), label: 'Forecast horizon' },
    { key: 'duration_min', value: plan.durationMin.toString(), label: 'Drill duration' },
    { key: 'allocated_kw', value: plan.allocatedKw, label: 'Allocated across mechanisms' },
    { key: 'shortfall_kw', value: plan.shortfallKw, label: 'Shortfall' },
    { key: 'feasible', value: String(plan.feasible), label: 'Plan feasible' },
    {
      key: 'response_seconds',
      value: plan.estimatedResponseSeconds.toString(),
      label: 'Estimated response time',
    },
    { key: 'rebound_window_min', value: plan.reboundWindowMin.toString(), label: 'Rebound watch window' },
    { key: 'risk_level', value: risk.level, label: 'Risk level' },
  ];

  for (const allocation of plan.allocations) {
    facts.push({
      key: `allocation_${allocation.code}`,
      value: allocation.allocatedKw,
      label: `Allocated to ${allocation.code}`,
    });
  }

  for (const factor of risk.factors) {
    facts.push({
      key: `risk_${factor.code}`,
      value: factor.severity,
      label: factor.detail,
    });
  }

  for (const anomaly of anomalies) {
    facts.push({
      key: `anomaly_${anomaly.code}`,
      value: anomaly.severity,
      label: anomaly.detail,
    });
  }

  // Every number that may legitimately appear, drawn only from verified values.
  const allowed = new Set<string>(ALWAYS_ALLOWED);
  for (const fact of facts) {
    for (const token of extractNumbers(fact.value)) {
      allowed.add(normaliseNumber(token));
    }
    // Facts whose label carries numbers (risk details, anomaly details) supply
    // them too — those strings were themselves produced by deterministic code.
    for (const token of extractNumbers(fact.label)) {
      allowed.add(normaliseNumber(token));
    }
  }
  // Percentage renderings of verified fractions, e.g. 0.25 -> "25".
  for (const fact of facts) {
    const numeric = Number(fact.value);
    if (Number.isFinite(numeric) && numeric > 0 && numeric <= 1) {
      allowed.add(normaliseNumber((numeric * 100).toFixed(1)));
      allowed.add(normaliseNumber(Math.round(numeric * 100).toString()));
    }
  }

  return { facts, allowedNumbers: [...allowed].sort(), claim, plan, risk, anomalies };
}

/**
 * Rejects an explanation containing any number absent from the verified set.
 *
 * This is the enforcement point for "the LLM explains verified data, it does not
 * invent data". It cannot catch a false qualitative claim, and does not pretend
 * to — but fabricated quantities are the failure that would put a wrong number
 * in front of an operator, and those it does catch.
 */
export function validateGrounding(text: string, context: ExplanationContext): GroundingResult {
  const allowed = new Set(context.allowedNumbers);
  const violations: GroundingViolation[] = [];
  const seen = new Set<string>();

  for (const token of extractNumbers(text)) {
    const normalised = normaliseNumber(token);
    if (allowed.has(normalised) || seen.has(normalised)) continue;
    seen.add(normalised);
    violations.push({
      token,
      reason: 'Number does not appear in any verified fact for this explanation.',
    });
  }

  return { grounded: violations.length === 0, violations };
}

/**
 * Deterministic explainer.
 *
 * Produces the explanation directly from verified facts, with no model and no
 * API key. This is the default so the feature works out of the box, and it is
 * the fallback whenever a model-backed explanation fails grounding.
 */
export class DeterministicExplainer implements Explainer {
  readonly source = 'DETERMINISTIC' as const;

  explain(context: ExplanationContext): string {
    const { claim, plan, risk } = context;
    const sentences: string[] = [];

    if (risk.blocked) {
      const blockers = risk.factors.filter((f) => f.severity === 'BLOCKER');
      sentences.push(
        `GridFlex is not recommending this drill. ${blockers.map((b) => b.detail).join(' ')}`,
      );
    } else if (!plan.feasible) {
      sentences.push(
        `GridFlex cannot meet the ${claim.claimedReducibleKw} kW target for ` +
          `${plan.durationMin} minutes; the plan falls ${plan.shortfallKw} kW short.`,
      );
    } else {
      sentences.push(
        `GridFlex recommends a ${claim.claimedReducibleKw} kW reduction for ` +
          `${plan.durationMin} minutes.`,
      );
    }

    if (plan.allocations.length > 0) {
      const parts = plan.allocations.map((a) => `${a.allocatedKw} kW from ${a.code}`);
      sentences.push(`The reduction comes from ${parts.join(', ')}.`);
    }

    if (plan.excluded.length > 0) {
      sentences.push(
        `Unavailable for this window: ${plan.excluded.map((e) => `${e.code} (${e.reasonCode})`).join(', ')}.`,
      );
    }

    if (plan.feasible && !risk.blocked) {
      sentences.push(
        `Expected response time is ${plan.estimatedResponseSeconds} seconds, with a ` +
          `${plan.reboundWindowMin} minute rebound watch afterwards.`,
      );
    }

    sentences.push(
      claim.bindingSide === 'ENVELOPE'
        ? `The figure is capped by the assurance envelope rather than the forecast, and carries ` +
          `a confidence of ${claim.claimedConfidence}.`
        : `Confidence is ${claim.claimedConfidence}.`,
    );

    const warnings = risk.factors.filter((f) => f.severity === 'WARNING');
    if (warnings.length > 0) {
      sentences.push(`Caveats: ${warnings.map((w) => w.detail).join(' ')}`);
    }

    return sentences.join(' ');
  }
}

/**
 * Produces an explanation and enforces grounding on it.
 *
 * A model-backed explanation that fails grounding is discarded and the
 * deterministic explanation is returned instead — the operator always gets a
 * correct explanation, never a suppressed one and never a fabricated one.
 */
export async function explainVerified(
  context: ExplanationContext,
  explainer: Explainer = new DeterministicExplainer(),
): Promise<Explanation> {
  const text = await explainer.explain(context);
  const grounding = validateGrounding(text, context);

  if (!grounding.grounded && explainer.source === 'MODEL') {
    const fallback = new DeterministicExplainer().explain(context);
    return {
      explainerVersion: EXPLAINER_VERSION,
      text: fallback,
      grounded: true,
      violations: grounding.violations,
      source: 'DETERMINISTIC',
    };
  }

  return {
    explainerVersion: EXPLAINER_VERSION,
    text,
    grounded: grounding.grounded,
    violations: grounding.violations,
    source: explainer.source,
  };
}

/**
 * Builds the prompt for a model-backed explainer.
 *
 * The model receives ONLY verified facts and is instructed to use no other
 * numbers. Exported so the prompt is reviewable and testable rather than buried
 * inside a provider call.
 */
export function buildExplanationPrompt(context: ExplanationContext): string {
  const facts = context.facts.map((f) => `- ${f.label}: ${f.value}`).join('\n');
  return [
    'You are explaining a verified flexibility assessment to a data-centre operator.',
    '',
    'RULES:',
    '- Use ONLY the facts below. Do not compute, estimate, infer, or round any value.',
    '- Every number in your response must appear verbatim in the facts.',
    '- Do not claim capacity is guaranteed. Do not soften a blocking risk.',
    '- Two to four sentences, plain professional English, no marketing language.',
    '',
    'VERIFIED FACTS:',
    facts,
  ].join('\n');
}
