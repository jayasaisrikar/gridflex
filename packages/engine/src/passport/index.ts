/**
 * Flexibility Passport assembly (spec §15.2).
 *
 * The Passport is the product. Once issued it is never edited — a later version
 * supersedes it, and revocation preserves the original and records a reason.
 *
 * Two properties define this module:
 *
 *   1. **Every field is traceable.** Nothing here is authored; every value
 *      arrives from telemetry, a constraint record, or a deterministic engine
 *      calculation, and carries the methodology version that produced it.
 *
 *   2. **Limitations are derived, never written.** The contract requires at
 *      least one limitation on every Passport, and `deriveLimitations` computes
 *      them from the facility's actual state. A hand-authored list would drift
 *      out of step with the evidence the moment either changed, and the whole
 *      point of the document is that its caveats are as reliable as its
 *      headline number.
 *
 * The document is sealed with `sealDocument`, so the stored JSON and its hash
 * are produced together and a verifier never has to guess which serialization
 * generated the digest.
 */
import {
  sealDocument,
  verifyDocument,
  type CanonicalDocument,
  type CanonicalInput,
} from '../canonical-json/index.js';
import type { Provenance } from '../envelope/index.js';

export const PASSPORT_SCHEMA_VERSION = 'gridflex-passport-1.0.0';

/**
 * Renders a ratio as a fixed 4-decimal string.
 *
 * Canonicalization rejects non-integer numbers outright (spec §15.1): a float
 * has no portable serialization, so 0.85 could hash differently on two runtimes
 * and the document would fail verification for no reason a reviewer could see.
 * Confidence and completeness therefore cross into the hashed document as
 * decimal strings, exactly as power values already do.
 */
function ratioString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Ratio must be finite, received ${value}`);
  }
  return value.toFixed(4);
}

/** Confidence at or below this is too weak to describe capacity as established. */
const LOW_CONFIDENCE_THRESHOLD = 0.5;

/** Modelling windows shorter than this cannot describe weekly behaviour. */
const SHORT_WINDOW_DAYS = 14;

export interface PassportFacility {
  readonly name: string;
  readonly timezone: string;
  readonly region: string | null;
  readonly market: string | null;
}

export interface PassportEnvelope {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly total_reducible_kw: string;
  readonly aggregate_ramp_kw_per_min: string;
  readonly sustainable_duration_min: number;
  readonly response_time_seconds: number;
  readonly confidence_score: number;
  readonly telemetry_completeness: number;
  readonly methodology_version: string;
  readonly constraints_version: number;
  readonly mechanisms: readonly {
    readonly code: string;
    readonly name: string;
    readonly provenance: Provenance;
    readonly reducible_kw: string;
    readonly test_count: number;
  }[];
}

export interface PassportSafety {
  readonly minimum_safe_load_kw: string;
  readonly maximum_curtailment_kw: string;
  readonly maximum_ramp_kw_per_min: string;
  readonly maximum_duration_min: number;
  readonly excluded_workloads: readonly string[];
  readonly constraints_version: number;
}

export interface PassportDataQuality {
  readonly completeness: number;
  readonly window_start: string;
  readonly window_end: string;
  readonly modeling_window_days: number;
  readonly connector_provenance: readonly {
    readonly connector_type: string;
    readonly name: string;
    readonly last_success_at: string | null;
  }[];
  readonly contains_simulated_data: boolean;
}

export interface PassportDrill {
  readonly drill_id: string;
  readonly name: string;
  readonly status: string;
  readonly started_at: string | null;
  readonly requested_reduction_kw: string;
  readonly delivered_energy_wh: string | null;
  readonly performance_bps: number | null;
  readonly simulation_mode: boolean;
}

export interface AssemblePassportInput {
  readonly id: string;
  readonly facility_id: string;
  readonly version: number;
  readonly evidence_bundle_id: string;
  readonly evidence_sha256: string;
  readonly issued_at: string | null;
  readonly facility: PassportFacility;
  readonly envelope: PassportEnvelope;
  readonly safety: PassportSafety;
  readonly data_quality: PassportDataQuality;
  readonly drill_history: readonly PassportDrill[];
  readonly has_external_review: boolean;
}

/**
 * Derives the limitations that must accompany this Passport.
 *
 * Ordered most to least material, so a reader who stops after the first line has
 * still seen the most important caveat. Every branch is driven by a value that
 * appears elsewhere in the document, so a limitation can never contradict the
 * evidence beside it.
 */
export function deriveLimitations(input: AssemblePassportInput): readonly string[] {
  const limitations: string[] = [];
  const { envelope, data_quality: quality, drill_history: drills } = input;

  if (quality.contains_simulated_data) {
    limitations.push(
      'This Passport contains simulated data. It demonstrates the methodology and must not be ' +
        'used as evidence of the facility’s real flexibility.',
    );
  }

  const realDrills = drills.filter((drill) => !drill.simulation_mode);
  if (realDrills.length === 0) {
    limitations.push(
      'No non-simulated drill has been completed at this facility. The stated capacity has not ' +
        'been demonstrated under real operating conditions.',
    );
  } else if (realDrills.length < 3) {
    limitations.push(
      `Capacity rests on ${realDrills.length} completed drill(s). Repeat performance across ` +
        'varied operating conditions has not been established.',
    );
  }

  const untested = envelope.mechanisms.filter((mechanism) => mechanism.provenance !== 'TESTED');
  if (untested.length === envelope.mechanisms.length && envelope.mechanisms.length > 0) {
    limitations.push(
      'Every mechanism is DECLARED or MODELED. No mechanism has been confirmed by a completed ' +
        'test, so the capacity figure is an operator declaration rather than a measurement.',
    );
  } else if (untested.length > 0) {
    limitations.push(
      `${untested.length} of ${envelope.mechanisms.length} mechanisms are untested ` +
        `(${untested.map((m) => m.code).join(', ')}). Their contribution is not evidenced.`,
    );
  }

  if (envelope.confidence_score <= LOW_CONFIDENCE_THRESHOLD) {
    limitations.push(
      `Confidence is ${envelope.confidence_score}. The supporting evidence is weak and the ` +
        'capacity should be treated as indicative only.',
    );
  }

  if (!input.has_external_review) {
    limitations.push(
      'This Passport has not been externally reviewed. Confidence is capped pending independent ' +
        'assessment.',
    );
  }

  if (quality.modeling_window_days < SHORT_WINDOW_DAYS) {
    limitations.push(
      `Derived from ${quality.modeling_window_days} day(s) of telemetry. This is too short to ` +
        'characterise weekday, weekend and seasonal variation.',
    );
  }

  if (quality.completeness < 1) {
    limitations.push(
      `Telemetry completeness over the window is ` +
        `${(quality.completeness * 100).toFixed(1)}%. Missing intervals contributed zero and were ` +
        'never interpolated.',
    );
  }

  // Statuses matching the `envelope_status` enum. CURRENT and DRAFT are the
  // ordinary states; the rest mean the envelope no longer describes the
  // facility, which a reader of the Passport must be told.
  if (envelope.status === 'STALE') {
    limitations.push(
      'The underlying envelope is STALE: the constraints or telemetry it was computed from have ' +
        'changed since. Recompute before relying on this capacity.',
    );
  } else if (envelope.status === 'SUPERSEDED') {
    limitations.push('The underlying envelope has been superseded by a newer version.');
  } else if (envelope.status === 'BLOCKED') {
    limitations.push(
      'The underlying envelope is BLOCKED, so no capacity is asserted by this Passport.',
    );
  }

  // The contract requires at least one limitation. Reaching this branch means a
  // fully tested, externally reviewed, complete facility — which still gets a
  // statement of scope rather than an empty list implying no caveats apply.
  if (limitations.length === 0) {
    limitations.push(
      'This Passport describes capacity under the operating conditions observed during the stated ' +
        'window. It is not a guarantee of availability at any future time.',
    );
  }

  return limitations;
}

export interface AssembledPassport {
  readonly document: { readonly [key: string]: CanonicalInput };
  readonly sealed: CanonicalDocument;
  readonly sha256: string;
  readonly limitations: readonly string[];
}

/**
 * Builds the Passport document and seals it.
 *
 * `status` is DRAFT until issued; `issued_at` being null and status DRAFT are
 * kept consistent here rather than left to the caller, because a document
 * claiming to be ISSUED with no issue time would be unverifiable.
 */
export function assemblePassport(input: AssemblePassportInput): AssembledPassport {
  const limitations = deriveLimitations(input);
  const status = input.issued_at === null ? 'DRAFT' : 'ISSUED';

  // Field order is irrelevant to the hash — canonicalization sorts keys — but a
  // stable authored order keeps diffs readable.
  const document: { readonly [key: string]: CanonicalInput } = {
    schema_version: PASSPORT_SCHEMA_VERSION,
    id: input.id,
    facility_id: input.facility_id,
    version: input.version,
    status,
    evidence_bundle_id: input.evidence_bundle_id,
    evidence_sha256: input.evidence_sha256,
    issued_at: input.issued_at,
    superseded_by: null,
    revocation_reason: null,
    facility: {
      name: input.facility.name,
      timezone: input.facility.timezone,
      region: input.facility.region,
      market: input.facility.market,
    },
    methodology_version: input.envelope.methodology_version,
    envelope: {
      id: input.envelope.id,
      version: input.envelope.version,
      status: input.envelope.status,
      total_reducible_kw: input.envelope.total_reducible_kw,
      aggregate_ramp_kw_per_min: input.envelope.aggregate_ramp_kw_per_min,
      sustainable_duration_min: input.envelope.sustainable_duration_min,
      response_time_seconds: input.envelope.response_time_seconds,
      confidence_score: ratioString(input.envelope.confidence_score),
      telemetry_completeness: ratioString(input.envelope.telemetry_completeness),
      methodology_version: input.envelope.methodology_version,
      constraints_version: input.envelope.constraints_version,
      mechanisms: input.envelope.mechanisms.map((mechanism) => ({
        code: mechanism.code,
        name: mechanism.name,
        provenance: mechanism.provenance,
        reducible_kw: mechanism.reducible_kw,
        test_count: mechanism.test_count,
      })),
    },
    safety: {
      minimum_safe_load_kw: input.safety.minimum_safe_load_kw,
      maximum_curtailment_kw: input.safety.maximum_curtailment_kw,
      maximum_ramp_kw_per_min: input.safety.maximum_ramp_kw_per_min,
      maximum_duration_min: input.safety.maximum_duration_min,
      excluded_workloads: [...input.safety.excluded_workloads],
      constraints_version: input.safety.constraints_version,
    },
    data_quality: {
      completeness: ratioString(input.data_quality.completeness),
      window_start: input.data_quality.window_start,
      window_end: input.data_quality.window_end,
      modeling_window_days: input.data_quality.modeling_window_days,
      connector_provenance: input.data_quality.connector_provenance.map((connector) => ({
        connector_type: connector.connector_type,
        name: connector.name,
        last_success_at: connector.last_success_at,
      })),
      contains_simulated_data: input.data_quality.contains_simulated_data,
    },
    drill_history: input.drill_history.map((drill) => ({
      drill_id: drill.drill_id,
      name: drill.name,
      status: drill.status,
      started_at: drill.started_at,
      requested_reduction_kw: drill.requested_reduction_kw,
      delivered_energy_wh: drill.delivered_energy_wh,
      performance_bps: drill.performance_bps,
      simulation_mode: drill.simulation_mode,
    })),
    limitations: [...limitations],
  };

  const sealed = sealDocument(document);
  return { document, sealed, sha256: sealed.sha256, limitations };
}

export interface PassportVerification {
  readonly passport_hash_matches: boolean;
  readonly recomputed_passport_sha256: string;
  readonly evidence_hash_matches: boolean;
  readonly recomputed_evidence_sha256: string;
  readonly canonicalization_schema_version: string;
  readonly instructions: string;
}

const VERIFY_INSTRUCTIONS =
  'Canonicalize the passport_json with sorted keys and UTC RFC 3339 timestamps, serialize as ' +
  'UTF-8 JSON, and take the SHA-256. The result must equal passport_sha256. Repeat for the ' +
  'evidence bundle against evidence_sha256.';

/**
 * Independently recomputes both hashes (spec §9.5, §24).
 *
 * Reports the comparison rather than throwing: a reviewer needs to see a
 * mismatch and what was actually computed, not an exception.
 */
export function verifyPassport(params: {
  readonly passportJson: { readonly [key: string]: CanonicalInput };
  readonly storedPassportSha256: string;
  readonly evidenceJson: { readonly [key: string]: CanonicalInput };
  readonly storedEvidenceSha256: string;
}): PassportVerification {
  const passport = verifyDocument(params.passportJson, params.storedPassportSha256);
  const evidence = verifyDocument(params.evidenceJson, params.storedEvidenceSha256);

  return {
    passport_hash_matches: passport.valid,
    recomputed_passport_sha256: passport.actualSha256,
    evidence_hash_matches: evidence.valid,
    recomputed_evidence_sha256: evidence.actualSha256,
    canonicalization_schema_version: 'gridflex-canonical-1',
    instructions: VERIFY_INSTRUCTIONS,
  };
}
