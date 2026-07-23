import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { passportDocumentSchema, type PassportDocument } from '@gridflex/contracts';
import { canonicalSha256 } from '@gridflex/engine';
import { renderPassportExport } from '../src/modules/passports/passports.controller.js';

const UUIDS = {
  passport: '10000000-0000-4000-8000-000000000001',
  facility: '10000000-0000-4000-8000-000000000002',
  evidence: '10000000-0000-4000-8000-000000000003',
  envelope: '10000000-0000-4000-8000-000000000004',
  mechanism: '10000000-0000-4000-8000-000000000005',
  drill: '10000000-0000-4000-8000-000000000006',
};

function document(facilityName = 'Pilot facility'): PassportDocument {
  return passportDocumentSchema.parse({
    id: UUIDS.passport,
    facility_id: UUIDS.facility,
    version: 1,
    evidence_bundle_id: UUIDS.evidence,
    evidence_sha256: 'a'.repeat(64),
    issued_at: '2026-07-23T12:00:00Z',
    facility: {
      name: facilityName,
      timezone: 'UTC',
      region: 'Texas',
      market: 'ERCOT',
    },
    methodology_version: 'gridflex-envelope-v1',
    envelope: {
      id: UUIDS.envelope,
      facility_id: UUIDS.facility,
      version: 1,
      status: 'CURRENT',
      as_of: '2026-07-23T11:00:00Z',
      valid_until: null,
      total_reducible_kw: '500.000',
      response_time_seconds: 300,
      sustainable_duration_min: 30,
      aggregate_ramp_kw_per_min: '100.000',
      rebound_peak_kw: null,
      rebound_duration_min: null,
      confidence_score: '0.8500',
      telemetry_completeness: '0.9900',
      methodology_version: 'gridflex-envelope-v1',
      constraints_version: 1,
      blocked_reasons: [],
      mechanisms: [
        {
          mechanism_id: UUIDS.mechanism,
          mechanism_code: 'WORKLOAD_SHIFT',
          mechanism_name: 'Workload shift',
          provenance: 'TESTED',
          reducible_kw: '500.000',
          response_time_seconds: 300,
          ramp_kw_per_min: '100.000',
          duration_min: 30,
          rebound_peak_kw: null,
          rebound_duration_min: null,
          confidence_score: '0.8500',
          evidence_refs: [],
          notes: null,
        },
      ],
      created_at: '2026-07-23T11:00:00Z',
    },
    safety: {
      minimum_safe_load_kw: '900.000',
      maximum_curtailment_kw: '600.000',
      maximum_ramp_kw_per_min: '100.000',
      maximum_duration_min: 60,
      excluded_workloads: ['life safety'],
      constraints_version: 1,
    },
    data_quality: {
      completeness: '0.9900',
      window_start: '2026-07-22T12:00:00Z',
      window_end: '2026-07-23T12:00:00Z',
      connector_provenance: [
        {
          connector_type: 'SIMULATOR',
          name: 'Pilot simulator',
          last_success_at: '2026-07-23T12:00:00Z',
        },
      ],
      contains_simulated_data: true,
    },
    drill_history: [
      {
        drill_id: UUIDS.drill,
        name: 'Pilot drill',
        status: 'COMPLETED',
        started_at: '2026-07-23T10:00:00Z',
        requested_reduction_kw: '500.000',
        delivered_energy_wh: '245000',
        performance_bps: 9800,
        simulation_mode: true,
      },
    ],
    limitations: ['Simulated pilot data; not a production dispatch claim.'],
    notes: null,
  });
}

describe('pilot Passport exports', () => {
  it('renders byte-stable canonical JSON with an independently reproducible hash', () => {
    const passport = document();
    const passportHash = canonicalSha256(passport);
    const first = renderPassportExport('JSON', passportHash, passport);
    const second = renderPassportExport('JSON', passportHash, passport);

    expect(first).toEqual(second);
    expect(first.contentType).toBe('application/json');
    expect(JSON.parse(first.content)).toEqual({
      document: passport,
      passport_sha256: passportHash,
    });
  });

  it('renders a deterministic flattened CSV and neutralizes spreadsheet formulas', () => {
    const passport = document('=HYPERLINK("https://invalid.example")');
    const rendered = renderPassportExport('CSV', 'b'.repeat(64), passport);

    expect(rendered.contentType).toContain('text/csv');
    expect(rendered.content).toContain('"document.facility.name"');
    expect(rendered.content).toContain('"\'=HYPERLINK(""https://invalid.example"")"');
    expect(rendered.content.split('\r\n')[0]).toBe('field,value');
  });

  it('renders a deterministic, explicitly non-canonical PDF report', () => {
    const first = renderPassportExport('PDF', 'c'.repeat(64), document());
    const second = renderPassportExport('PDF', 'c'.repeat(64), document());
    const bytes = Buffer.from(first.content, 'base64');

    expect(first).toEqual(second);
    expect(first.contentType).toBe('application/pdf');
    expect(first.contentEncoding).toBe('base64');
    expect(bytes.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4');
    expect(bytes.toString('ascii')).toContain('SIMULATED PILOT EVIDENCE');
    expect(bytes.toString('ascii')).toContain('Readable derivative');
  });

  it('refuses an unsupported format instead of producing a misleading file', () => {
    expect(() => renderPassportExport('XML', 'c'.repeat(64), document())).toThrow(
      /Unsupported export format/,
    );
  });
});
