import { describe, expect, it } from 'vitest';
import {
  PASSPORT_SCHEMA_VERSION,
  assemblePassport,
  deriveLimitations,
  verifyPassport,
  type AssemblePassportInput,
} from '../src/passport/index.js';

/** A facility with nothing to apologise for: tested, reviewed, complete. */
function idealInput(overrides: Partial<AssemblePassportInput> = {}): AssemblePassportInput {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    facility_id: '22222222-2222-4222-8222-222222222222',
    version: 1,
    evidence_bundle_id: '33333333-3333-4333-8333-333333333333',
    evidence_sha256: 'a'.repeat(64),
    issued_at: null,
    facility: { name: 'Test Facility', timezone: 'UTC', region: 'ERCOT', market: 'RTM' },
    envelope: {
      id: '44444444-4444-4444-8444-444444444444',
      version: 3,
      status: 'CURRENT',
      total_reducible_kw: '600.000',
      aggregate_ramp_kw_per_min: '250.000',
      sustainable_duration_min: 30,
      response_time_seconds: 144,
      confidence_score: 0.85,
      telemetry_completeness: 1,
      methodology_version: 'gridflex-envelope-1.0.0',
      constraints_version: 2,
      mechanisms: [
        {
          code: 'WORKLOAD_DEFERRAL',
          name: 'Deferrable compute',
          provenance: 'TESTED',
          reducible_kw: '350.000',
          test_count: 4,
        },
      ],
    },
    safety: {
      minimum_safe_load_kw: '900.000',
      maximum_curtailment_kw: '600.000',
      maximum_ramp_kw_per_min: '100.000',
      maximum_duration_min: 60,
      excluded_workloads: [],
      constraints_version: 2,
    },
    data_quality: {
      completeness: 1,
      window_start: '2026-06-01T00:00:00Z',
      window_end: '2026-07-01T00:00:00Z',
      modeling_window_days: 30,
      connector_provenance: [
        { connector_type: 'INTERVAL_METER_API', name: 'Main meter', last_success_at: '2026-07-01T00:00:00Z' },
      ],
      contains_simulated_data: false,
    },
    drill_history: [
      {
        drill_id: '55555555-5555-4555-8555-555555555555',
        name: 'Drill A',
        status: 'COMPLETED',
        started_at: '2026-06-10T12:00:00Z',
        requested_reduction_kw: '500.000',
        delivered_energy_wh: '244724',
        performance_bps: 9789,
        simulation_mode: false,
      },
      { drill_id: 'd2', name: 'B', status: 'COMPLETED', started_at: null, requested_reduction_kw: '500.000', delivered_energy_wh: '1', performance_bps: 1, simulation_mode: false },
      { drill_id: 'd3', name: 'C', status: 'COMPLETED', started_at: null, requested_reduction_kw: '500.000', delivered_energy_wh: '1', performance_bps: 1, simulation_mode: false },
    ],
    has_external_review: true,
    ...overrides,
  };
}

describe('deriveLimitations — never empty', () => {
  it('always produces at least one limitation, per the contract', () => {
    // An empty list would imply no caveats apply, which is never true of a
    // forward-looking capacity claim.
    const limitations = deriveLimitations(idealInput());
    expect(limitations.length).toBeGreaterThanOrEqual(1);
    expect(limitations[0]).toMatch(/not a guarantee of availability/);
  });
});

describe('deriveLimitations — simulated data', () => {
  it('leads with the simulation warning', () => {
    // Most material caveat first: a reader who stops after one line must still
    // learn the numbers are not real.
    const limitations = deriveLimitations(
      idealInput({
        data_quality: { ...idealInput().data_quality, contains_simulated_data: true },
      }),
    );
    expect(limitations[0]).toMatch(/contains simulated data/i);
    expect(limitations[0]).toMatch(/must not be used as evidence/i);
  });
});

describe('deriveLimitations — drill evidence', () => {
  it('states plainly when no real drill has been run', () => {
    const limitations = deriveLimitations(idealInput({ drill_history: [] }));
    expect(limitations.join(' ')).toMatch(/No non-simulated drill has been completed/);
  });

  it('counts simulated drills as no evidence', () => {
    // A simulated drill demonstrates the pipeline, not the facility.
    const limitations = deriveLimitations(
      idealInput({
        drill_history: [
          { drill_id: 'd1', name: 'Sim', status: 'COMPLETED', started_at: null, requested_reduction_kw: '500.000', delivered_energy_wh: '1', performance_bps: 1, simulation_mode: true },
        ],
      }),
    );
    expect(limitations.join(' ')).toMatch(/No non-simulated drill/);
  });

  it('flags a thin track record', () => {
    const limitations = deriveLimitations(
      idealInput({ drill_history: [idealInput().drill_history[0]!] }),
    );
    expect(limitations.join(' ')).toMatch(/rests on 1 completed drill/);
  });

  it('says nothing about drills once three real ones exist', () => {
    expect(deriveLimitations(idealInput()).join(' ')).not.toMatch(/completed drill\(s\)/);
  });
});

describe('deriveLimitations — mechanism provenance', () => {
  it('states that an all-DECLARED envelope is a declaration, not a measurement', () => {
    const input = idealInput();
    const limitations = deriveLimitations({
      ...input,
      envelope: {
        ...input.envelope,
        mechanisms: input.envelope.mechanisms.map((m) => ({ ...m, provenance: 'DECLARED' as const, test_count: 0 })),
      },
    });
    expect(limitations.join(' ')).toMatch(/operator declaration rather than a measurement/);
  });

  it('names the untested mechanisms when only some are untested', () => {
    const input = idealInput();
    const limitations = deriveLimitations({
      ...input,
      envelope: {
        ...input.envelope,
        mechanisms: [
          ...input.envelope.mechanisms,
          { code: 'UPS_BESS', name: 'Storage', provenance: 'DECLARED', reducible_kw: '150.000', test_count: 0 },
        ],
      },
    });
    expect(limitations.join(' ')).toMatch(/1 of 2 mechanisms are untested \(UPS_BESS\)/);
  });
});

describe('deriveLimitations — envelope status', () => {
  it.each(['CURRENT', 'DRAFT'] as const)('adds no status limitation for %s', (status) => {
    const input = idealInput();
    const limitations = deriveLimitations({ ...input, envelope: { ...input.envelope, status } });
    expect(limitations.join(' ')).not.toMatch(/envelope is|envelope has been/);
  });

  it('warns that a STALE envelope must be recomputed', () => {
    const input = idealInput();
    const limitations = deriveLimitations({
      ...input,
      envelope: { ...input.envelope, status: 'STALE' },
    });
    expect(limitations.join(' ')).toMatch(/STALE.*Recompute before relying/s);
  });

  it('states that a BLOCKED envelope asserts no capacity', () => {
    const input = idealInput();
    const limitations = deriveLimitations({
      ...input,
      envelope: { ...input.envelope, status: 'BLOCKED' },
    });
    expect(limitations.join(' ')).toMatch(/BLOCKED, so no capacity is asserted/);
  });
});

describe('deriveLimitations — confidence, review, window, completeness', () => {
  it('flags low confidence', () => {
    const input = idealInput();
    const limitations = deriveLimitations({
      ...input,
      envelope: { ...input.envelope, confidence_score: 0.25 },
    });
    expect(limitations.join(' ')).toMatch(/Confidence is 0.25.*indicative only/s);
  });

  it('flags the absence of external review', () => {
    const limitations = deriveLimitations(idealInput({ has_external_review: false }));
    expect(limitations.join(' ')).toMatch(/not been externally reviewed/);
  });

  it('flags a short modelling window', () => {
    const input = idealInput();
    const limitations = deriveLimitations({
      ...input,
      data_quality: { ...input.data_quality, modeling_window_days: 1 },
    });
    expect(limitations.join(' ')).toMatch(/1 day\(s\) of telemetry.*too short/s);
  });

  it('flags incomplete telemetry and states gaps were not interpolated', () => {
    const input = idealInput();
    const limitations = deriveLimitations({
      ...input,
      data_quality: { ...input.data_quality, completeness: 0.93 },
    });
    expect(limitations.join(' ')).toMatch(/93.0%.*never interpolated/s);
  });

  it('accumulates every applicable limitation', () => {
    const input = idealInput();
    const limitations = deriveLimitations({
      ...input,
      has_external_review: false,
      drill_history: [],
      envelope: {
        ...input.envelope,
        confidence_score: 0.2,
        mechanisms: input.envelope.mechanisms.map((m) => ({ ...m, provenance: 'DECLARED' as const })),
      },
      data_quality: { ...input.data_quality, contains_simulated_data: true, completeness: 0.8, modeling_window_days: 1 },
    });
    expect(limitations.length).toBeGreaterThanOrEqual(6);
    // The simulation warning still leads.
    expect(limitations[0]).toMatch(/simulated data/i);
  });
});

describe('assemblePassport', () => {
  it('seals the document and reports its hash', () => {
    const passport = assemblePassport(idealInput());
    expect(passport.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(passport.sealed.sha256).toBe(passport.sha256);
    expect(passport.document.schema_version).toBe(PASSPORT_SCHEMA_VERSION);
  });

  it('is byte-identical for identical input', () => {
    // A Passport that hashed differently on each assembly could never be verified.
    const first = assemblePassport(idealInput());
    const second = assemblePassport(idealInput());
    expect(second.sha256).toBe(first.sha256);
    expect(second.sealed.canonicalText).toBe(first.sealed.canonicalText);
  });

  it('changes hash when ANY material field changes', () => {
    const base = assemblePassport(idealInput()).sha256;
    const input = idealInput();

    const variants: AssemblePassportInput[] = [
      { ...input, version: 2 },
      { ...input, envelope: { ...input.envelope, total_reducible_kw: '600.001' } },
      { ...input, envelope: { ...input.envelope, confidence_score: 0.86 } },
      { ...input, safety: { ...input.safety, minimum_safe_load_kw: '900.001' } },
      { ...input, data_quality: { ...input.data_quality, completeness: 0.999 } },
      { ...input, evidence_sha256: 'b'.repeat(64) },
    ];
    for (const variant of variants) {
      expect(assemblePassport(variant).sha256).not.toBe(base);
    }
  });

  it('carries contains_simulated_data INSIDE the hashed document', () => {
    // A simulated Passport must not be launderable into looking real by
    // stripping a flag that lived outside the hash.
    const input = idealInput();
    const real = assemblePassport(input);
    const simulated = assemblePassport({
      ...input,
      data_quality: { ...input.data_quality, contains_simulated_data: true },
    });

    expect(
      (simulated.document.data_quality as Record<string, unknown>).contains_simulated_data,
    ).toBe(true);
    expect(simulated.sha256).not.toBe(real.sha256);
  });

  it('embeds the derived limitations in the hashed document', () => {
    // Editing the caveats after issue must break the hash.
    const passport = assemblePassport(idealInput({ has_external_review: false }));
    const limitations = passport.document.limitations as string[];
    expect(limitations.join(' ')).toMatch(/not been externally reviewed/);
    expect(limitations).toEqual(passport.limitations);
  });

  it('is DRAFT until an issue time exists', () => {
    expect(assemblePassport(idealInput()).document.status).toBe('DRAFT');
    expect(
      assemblePassport(idealInput({ issued_at: '2026-07-21T12:00:00Z' })).document.status,
    ).toBe('ISSUED');
  });

  it('never emits a superseded or revoked document from assembly', () => {
    const document = assemblePassport(idealInput()).document;
    expect(document.superseded_by).toBeNull();
    expect(document.revocation_reason).toBeNull();
  });
});

describe('verifyPassport', () => {
  const passport = assemblePassport(idealInput());
  const evidence = { schema_version: 'gridflex-canonical-1', delivered_energy_wh: '244724' };
  const evidenceSealed = assemblePassport(idealInput()); // reuse sealing machinery

  it('confirms an intact document', () => {
    const result = verifyPassport({
      passportJson: passport.document,
      storedPassportSha256: passport.sha256,
      evidenceJson: passport.document,
      storedEvidenceSha256: passport.sha256,
    });
    expect(result.passport_hash_matches).toBe(true);
    expect(result.recomputed_passport_sha256).toBe(passport.sha256);
  });

  it('DETECTS a tampered document', () => {
    const tampered = { ...passport.document, version: 99 };
    const result = verifyPassport({
      passportJson: tampered,
      storedPassportSha256: passport.sha256,
      evidenceJson: passport.document,
      storedEvidenceSha256: passport.sha256,
    });
    expect(result.passport_hash_matches).toBe(false);
    expect(result.recomputed_passport_sha256).not.toBe(passport.sha256);
  });

  it('detects a tampered evidence bundle independently', () => {
    const result = verifyPassport({
      passportJson: passport.document,
      storedPassportSha256: passport.sha256,
      evidenceJson: { ...evidence, delivered_energy_wh: '999999' },
      storedEvidenceSha256: evidenceSealed.sha256,
    });
    expect(result.passport_hash_matches).toBe(true);
    expect(result.evidence_hash_matches).toBe(false);
  });

  it('reports rather than throws, and explains how to verify independently', () => {
    const result = verifyPassport({
      passportJson: passport.document,
      storedPassportSha256: 'f'.repeat(64),
      evidenceJson: passport.document,
      storedEvidenceSha256: 'f'.repeat(64),
    });
    expect(result.passport_hash_matches).toBe(false);
    expect(result.instructions).toMatch(/sorted keys.*SHA-256/s);
    expect(result.canonicalization_schema_version).toBe('gridflex-canonical-1');
  });
});
