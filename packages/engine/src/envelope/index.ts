/**
 * Flexibility envelope engine (spec §12).
 *
 * Deterministic and versioned. Every output field carries provenance
 * (DECLARED / MODELED / TESTED) and every adjustment is recorded as a decision
 * so the number can be explained rather than merely asserted.
 */
import { type MilliKw, kwNumberToMilliKw, maxBigInt, milliKwToKwString, minBigInt } from '../units.js';

export const ENVELOPE_METHODOLOGY_VERSION = 'gridflex-envelope-1.0.0';

export type Provenance = 'DECLARED' | 'MODELED' | 'TESTED';

/** Base confidence by weakest data source (spec §12.2). */
export const BASE_CONFIDENCE: Readonly<Record<Provenance, number>> = {
  DECLARED: 0.35,
  MODELED: 0.6,
  TESTED: 0.85,
};

/**
 * Confidence is capped until an external reviewer or production event is
 * recorded (spec §12.2). The engine may never claim near-certainty on its own.
 */
export const CONFIDENCE_CAP_WITHOUT_EXTERNAL_REVIEW = 0.95;

/** Minimum completeness to compute an envelope at all (spec §10.2). */
export const MINIMUM_COMPLETENESS_FOR_ENVELOPE = 0.9;

export interface MechanismInput {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly declaredReducibleKw: number | null;
  /** Cap derived from telemetry, when the data supports one. */
  readonly observedReducibleKw: number | null;
  /** Cap imposed by an operator constraint specific to this mechanism. */
  readonly constraintCapKw: number | null;
  readonly rampKwPerMin: number | null;
  readonly maximumDurationMin: number | null;
  readonly reboundWindowMin: number | null;
  /** A completed drill that exercised this mechanism promotes it to TESTED. */
  readonly testedReducibleKw: number | null;
  readonly testCount: number;
}

export interface EnvelopeInput {
  readonly mechanisms: readonly MechanismInput[];
  readonly p50NormalLoadKw: number;
  readonly minimumSafeLoadKw: number;
  readonly maximumCurtailmentKw: number;
  readonly maximumRampKwPerMin: number;
  readonly maximumDurationMin: number;
  readonly telemetryCompleteness: number;
  readonly modelingWindowDays: number;
  readonly constraintsVersion: number;
  /** Age of the constraint record in days; stale constraints reduce confidence. */
  readonly constraintsAgeDays: number;
  readonly hasExternalReview: boolean;
}

export interface EngineDecision {
  readonly decisionType: string;
  readonly decisionCode: string;
  readonly severity: 'INFO' | 'WARNING' | 'BLOCKER';
  readonly facts: Record<string, unknown>;
  readonly rulesEvaluated: readonly string[];
}

export interface ConfidenceAdjustment {
  readonly code: string;
  readonly delta: number;
  readonly reason: string;
}

export interface MechanismResult {
  readonly mechanismId: string;
  readonly code: string;
  readonly name: string;
  readonly provenance: Provenance;
  readonly reducibleKw: string;
  readonly rampKwPerMin: string;
  readonly durationMin: number;
  readonly confidenceScore: number;
  readonly bindingCap: string;
  readonly notes: string | null;
}

export interface EnvelopeResult {
  readonly methodologyVersion: string;
  readonly status: 'DRAFT' | 'BLOCKED';
  readonly totalReducibleKw: string;
  readonly aggregateRampKwPerMin: string;
  readonly sustainableDurationMin: number;
  readonly responseTimeSeconds: number;
  readonly confidenceScore: number;
  readonly telemetryCompleteness: number;
  readonly constraintsVersion: number;
  readonly bindingConstraint: string;
  readonly mechanisms: readonly MechanismResult[];
  readonly decisions: readonly EngineDecision[];
  readonly confidenceAdjustments: readonly ConfidenceAdjustment[];
  readonly blockedReasons: readonly { code: string; detail: string }[];
}

/**
 * Computes the envelope (spec §12.1 sequence, §12.2 formulas):
 *
 *   physical_headroom_kw = max(0, p50_normal_load_kw - minimum_safe_load_kw)
 *   mechanism_cap_kw     = min(declared_cap_kw, observed_cap_kw, constraint_cap_kw)
 *   total_reducible_kw   = min(sum(enabled caps), physical_headroom_kw, maximum_curtailment_kw)
 */
export function computeEnvelope(input: EnvelopeInput): EnvelopeResult {
  const decisions: EngineDecision[] = [];
  const blockedReasons: { code: string; detail: string }[] = [];

  // Gate 1: data quality (spec §10.2). A blocked envelope still records WHY.
  if (input.telemetryCompleteness < MINIMUM_COMPLETENESS_FOR_ENVELOPE) {
    blockedReasons.push({
      code: 'ENVELOPE_BLOCKED_DATA_QUALITY',
      detail: `Telemetry completeness ${(input.telemetryCompleteness * 100).toFixed(1)}% is below the required ${MINIMUM_COMPLETENESS_FOR_ENVELOPE * 100}%.`,
    });
    decisions.push({
      decisionType: 'DATA_QUALITY',
      decisionCode: 'ENVELOPE_BLOCKED_DATA_QUALITY',
      severity: 'BLOCKER',
      facts: {
        completeness: input.telemetryCompleteness,
        required: MINIMUM_COMPLETENESS_FOR_ENVELOPE,
        window_days: input.modelingWindowDays,
      },
      rulesEvaluated: ['completeness >= 0.90'],
    });
  }

  const enabled = input.mechanisms.filter((mechanism) => mechanism.enabled);
  if (enabled.length === 0) {
    blockedReasons.push({
      code: 'NO_ENABLED_MECHANISMS',
      detail: 'No flexibility mechanisms are enabled for this facility.',
    });
    decisions.push({
      decisionType: 'CONFIGURATION',
      decisionCode: 'NO_ENABLED_MECHANISMS',
      severity: 'BLOCKER',
      facts: { total_mechanisms: input.mechanisms.length },
      rulesEvaluated: ['enabled_mechanism_count > 0'],
    });
  }

  const mechanismResults: MechanismResult[] = [];
  let sumOfCaps = 0n;

  for (const mechanism of enabled) {
    const result = evaluateMechanism(mechanism, input, decisions);
    mechanismResults.push(result);
    sumOfCaps += kwNumberToMilliKw(Number(result.reducibleKw));
  }

  // physical_headroom_kw = max(0, p50_normal_load - minimum_safe_load)
  const physicalHeadroom = maxBigInt(
    0n,
    kwNumberToMilliKw(input.p50NormalLoadKw) - kwNumberToMilliKw(input.minimumSafeLoadKw),
  );
  const maximumCurtailment = kwNumberToMilliKw(input.maximumCurtailmentKw);

  // total = min(sum of caps, physical headroom, maximum curtailment)
  const candidates: { label: string; value: MilliKw }[] = [
    { label: 'SUM_OF_MECHANISM_CAPS', value: sumOfCaps },
    { label: 'PHYSICAL_HEADROOM', value: physicalHeadroom },
    { label: 'MAXIMUM_CURTAILMENT', value: maximumCurtailment },
  ];
  const totalReducible = minBigInt(candidates.map((candidate) => candidate.value));
  const binding =
    candidates.find((candidate) => candidate.value === totalReducible)?.label ?? 'UNKNOWN';

  decisions.push({
    decisionType: 'AGGREGATION',
    decisionCode: 'TOTAL_REDUCIBLE_CAPPED',
    severity: 'INFO',
    facts: {
      sum_of_mechanism_caps_kw: milliKwToKwString(sumOfCaps),
      physical_headroom_kw: milliKwToKwString(physicalHeadroom),
      maximum_curtailment_kw: milliKwToKwString(maximumCurtailment),
      selected_kw: milliKwToKwString(totalReducible),
      binding_constraint: binding,
    },
    rulesEvaluated: [
      'total_reducible_kw = min(sum(enabled mechanism caps), physical_headroom_kw, maximum_curtailment_kw)',
    ],
  });

  // Aggregate ramp is capped by the facility limit.
  const mechanismRampSum = mechanismResults.reduce(
    (accumulator, mechanism) => accumulator + kwNumberToMilliKw(Number(mechanism.rampKwPerMin)),
    0n,
  );
  const aggregateRamp = minBigInt([mechanismRampSum, kwNumberToMilliKw(input.maximumRampKwPerMin)]);

  // Sustainable duration is the SHORTEST contributing mechanism duration — the
  // envelope cannot be sustained longer than its weakest component.
  const sustainableDuration =
    mechanismResults.length > 0
      ? Math.min(
          input.maximumDurationMin,
          ...mechanismResults.map((mechanism) => mechanism.durationMin),
        )
      : 0;

  const { confidence, adjustments } = computeConfidence(
    mechanismResults,
    input,
    blockedReasons.length > 0,
  );

  return {
    methodologyVersion: ENVELOPE_METHODOLOGY_VERSION,
    status: blockedReasons.length > 0 ? 'BLOCKED' : 'DRAFT',
    totalReducibleKw: milliKwToKwString(blockedReasons.length > 0 ? 0n : totalReducible),
    aggregateRampKwPerMin: milliKwToKwString(aggregateRamp),
    sustainableDurationMin: sustainableDuration,
    // Conservative default until measured from real transitions.
    responseTimeSeconds: 60,
    confidenceScore: confidence,
    telemetryCompleteness: input.telemetryCompleteness,
    constraintsVersion: input.constraintsVersion,
    bindingConstraint: binding,
    mechanisms: mechanismResults,
    decisions,
    confidenceAdjustments: adjustments,
    blockedReasons,
  };
}

function evaluateMechanism(
  mechanism: MechanismInput,
  input: EnvelopeInput,
  decisions: EngineDecision[],
): MechanismResult {
  // Provenance is the strongest evidence actually available — never assumed.
  const provenance: Provenance =
    mechanism.testedReducibleKw !== null && mechanism.testCount > 0
      ? 'TESTED'
      : mechanism.observedReducibleKw !== null
        ? 'MODELED'
        : 'DECLARED';

  // mechanism_cap_kw = min(declared, observed, constraint) over available values.
  const caps: { label: string; value: number }[] = [];
  if (mechanism.declaredReducibleKw !== null) {
    caps.push({ label: 'DECLARED', value: mechanism.declaredReducibleKw });
  }
  if (mechanism.observedReducibleKw !== null) {
    caps.push({ label: 'OBSERVED', value: mechanism.observedReducibleKw });
  }
  if (mechanism.constraintCapKw !== null) {
    caps.push({ label: 'CONSTRAINT', value: mechanism.constraintCapKw });
  }
  if (mechanism.testedReducibleKw !== null) {
    caps.push({ label: 'TESTED', value: mechanism.testedReducibleKw });
  }

  const selected =
    caps.length === 0
      ? { label: 'NO_DATA', value: 0 }
      : caps.reduce((lowest, cap) => (cap.value < lowest.value ? cap : lowest));

  if (caps.length === 0) {
    decisions.push({
      decisionType: 'MECHANISM',
      decisionCode: 'MECHANISM_NO_CAPACITY_DATA',
      severity: 'WARNING',
      facts: { mechanism_code: mechanism.code },
      rulesEvaluated: ['at least one of declared/observed/constraint/tested must be present'],
    });
  }

  decisions.push({
    decisionType: 'MECHANISM',
    decisionCode: 'MECHANISM_CAP_SELECTED',
    severity: 'INFO',
    facts: {
      mechanism_code: mechanism.code,
      provenance,
      candidates: Object.fromEntries(caps.map((cap) => [cap.label, cap.value])),
      selected_kw: selected.value,
      binding_cap: selected.label,
    },
    rulesEvaluated: ['mechanism_cap_kw = min(declared_cap_kw, observed_cap_kw, constraint_cap_kw)'],
  });

  const baseConfidence = BASE_CONFIDENCE[provenance];
  const durationMin = Math.min(
    mechanism.maximumDurationMin ?? input.maximumDurationMin,
    input.maximumDurationMin,
  );

  return {
    mechanismId: mechanism.id,
    code: mechanism.code,
    name: mechanism.name,
    provenance,
    reducibleKw: milliKwToKwString(kwNumberToMilliKw(selected.value)),
    rampKwPerMin: milliKwToKwString(
      kwNumberToMilliKw(Math.min(mechanism.rampKwPerMin ?? input.maximumRampKwPerMin, input.maximumRampKwPerMin)),
    ),
    durationMin,
    confidenceScore: baseConfidence,
    bindingCap: selected.label,
    notes: caps.length === 0 ? 'No capacity data available; treated as zero.' : null,
  };
}

/**
 * Confidence starts from the WEAKEST mechanism's data source and is penalised
 * for missing data, stale constraints, and short windows (spec §12.2). Every
 * adjustment is returned so the score can be explained line by line.
 */
export function computeConfidence(
  mechanisms: readonly MechanismResult[],
  input: EnvelopeInput,
  blocked: boolean,
): { confidence: number; adjustments: ConfidenceAdjustment[] } {
  const adjustments: ConfidenceAdjustment[] = [];

  if (blocked || mechanisms.length === 0) {
    return {
      confidence: 0,
      adjustments: [
        { code: 'BLOCKED', delta: 0, reason: 'Envelope is blocked; confidence is not asserted.' },
      ],
    };
  }

  // Start from the weakest link, not the average — one DECLARED mechanism in the
  // mix means the aggregate is only as trustworthy as that mechanism.
  let confidence = Math.min(...mechanisms.map((mechanism) => mechanism.confidenceScore));
  adjustments.push({
    code: 'BASE_WEAKEST_PROVENANCE',
    delta: confidence,
    reason: `Base confidence from the weakest mechanism provenance.`,
  });

  const penalise = (code: string, delta: number, reason: string) => {
    confidence += delta;
    adjustments.push({ code, delta, reason });
  };

  if (input.telemetryCompleteness < 0.95) {
    penalise(
      'INCOMPLETE_TELEMETRY',
      -0.05,
      `Telemetry completeness ${(input.telemetryCompleteness * 100).toFixed(1)}% is below the 95% production target.`,
    );
  }
  if (input.modelingWindowDays < 14) {
    penalise(
      'SHORT_MODELING_WINDOW',
      -0.1,
      `Modeling window of ${input.modelingWindowDays} days is shorter than the 14-day target.`,
    );
  }
  if (input.constraintsAgeDays > 180) {
    penalise(
      'STALE_CONSTRAINTS',
      -0.05,
      `Safety constraints were last reviewed ${input.constraintsAgeDays} days ago.`,
    );
  }
  const withoutData = mechanisms.filter((mechanism) => mechanism.bindingCap === 'NO_DATA');
  if (withoutData.length > 0) {
    penalise(
      'MECHANISM_MISSING_DATA',
      -0.05 * withoutData.length,
      `${withoutData.length} mechanism(s) have no capacity data.`,
    );
  }

  // Hard cap until externally reviewed (spec §12.2).
  if (!input.hasExternalReview && confidence > CONFIDENCE_CAP_WITHOUT_EXTERNAL_REVIEW) {
    adjustments.push({
      code: 'CAPPED_PENDING_EXTERNAL_REVIEW',
      delta: CONFIDENCE_CAP_WITHOUT_EXTERNAL_REVIEW - confidence,
      reason: 'Confidence is capped at 0.95 until an external reviewer or production event is recorded.',
    });
    confidence = CONFIDENCE_CAP_WITHOUT_EXTERNAL_REVIEW;
  }

  confidence = Math.max(0, Math.min(1, confidence));
  // Round to 4 decimals to match numeric(5,4).
  return { confidence: Math.round(confidence * 10_000) / 10_000, adjustments };
}
