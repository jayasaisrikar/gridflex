import { describe, expect, it } from 'vitest';
import {
  CARBON_MRV_VERSION,
  CarbonInputError,
  computeCarbonReport,
  type GridEmissionFactor,
} from '../src/carbon/index.js';
import { canonicalSha256 } from '../src/canonical-json/index.js';

const FACTOR: GridEmissionFactor = {
  kgCo2ePerKwh: '0.405',
  source: 'Declared fixture factor for the DEWA network',
  version: 'uae-fixture-2026',
};

const BASE = {
  deliveredEnergyWh: 1_250_000n, // 1,250 kWh — the Dubai demo drill's commitment
  baselineEnergyWh: 1_310_000n,
  emissionFactor: FACTOR,
  periodStart: '2026-08-15T08:00:00Z',
  periodEnd: '2026-08-15T08:30:00Z',
  facilityId: '22222222-2222-4222-8222-222222222222',
  drillId: 'drill-1',
  evidenceSha256: 'abc123',
};

describe('Scope 2 carbon MRV', () => {
  it('computes avoided tCO2e exactly: 1,250 kWh × 0.405 kg/kWh = 0.506 kg', () => {
    const report = computeCarbonReport(BASE);
    // 1250 × 0.405 = 506.25 kg = 0.50625 t → rounds to 0.506 t.
    expect(report.avoidedTco2e).toBe('0.506');
    expect(report.scope).toBe('SCOPE_2_LOCATION_BASED');
    expect(report.methodologyVersion).toBe(CARBON_MRV_VERSION);
  });

  it('computes the counterfactual baseline separately', () => {
    const report = computeCarbonReport(BASE);
    // 1310 × 0.405 = 530.55 kg = 0.53055 t → 0.531 t.
    expect(report.baselineTco2e).toBe('0.531');
  });

  it('seals the report with a canonical SHA-256', () => {
    const report = computeCarbonReport(BASE);
    const unsigned = {
      methodologyVersion: report.methodologyVersion,
      scope: report.scope,
      facilityId: report.facilityId,
      drillId: report.drillId,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      deliveredEnergyKwh: report.deliveredEnergyKwh,
      emissionFactor: report.emissionFactor,
      avoidedTco2e: report.avoidedTco2e,
      baselineTco2e: report.baselineTco2e,
      evidenceSha256: report.evidenceSha256,
    };
    expect(report.reportSha256).toBe(canonicalSha256(unsigned));
    expect(report.reportSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the declared factor and its source in the sealed document', () => {
    const report = computeCarbonReport(BASE);
    expect(report.emissionFactor.source).toContain('DEWA');
    expect(report.emissionFactor.version).toBe('uae-fixture-2026');
    expect(report.evidenceSha256).toBe('abc123');
  });

  it('rounds half-up at exactly .0005 of a tonne', () => {
    // 1 kWh × 0.5 kg/kWh = 0.0005 t → rounds to 0.001.
    const report = computeCarbonReport({
      ...BASE,
      deliveredEnergyWh: 1000n,
      baselineEnergyWh: 1000n,
      emissionFactor: { ...FACTOR, kgCo2ePerKwh: '0.500' },
    });
    expect(report.avoidedTco2e).toBe('0.001');
  });

  it('reports zero cleanly', () => {
    const report = computeCarbonReport({
      ...BASE,
      deliveredEnergyWh: 0n,
      baselineEnergyWh: 500_000n,
    });
    expect(report.avoidedTco2e).toBe('0.000');
    expect(report.deliveredEnergyKwh).toBe('0.000');
  });

  it('refuses negative or inconsistent energies', () => {
    expect(() =>
      computeCarbonReport({ ...BASE, deliveredEnergyWh: -1n }),
    ).toThrow(CarbonInputError);
    expect(() =>
      computeCarbonReport({ ...BASE, baselineEnergyWh: 5n }),
    ).toThrow(CarbonInputError);
  });

  it('refuses a malformed factor instead of guessing', () => {
    expect(() =>
      computeCarbonReport({
        ...BASE,
        emissionFactor: { ...FACTOR, kgCo2ePerKwh: 'not-a-number' },
      }),
    ).toThrow(CarbonInputError);
  });

  it('never uses float arithmetic for large Dubai-scale volumes', () => {
    // 3,500 kW × 5 h at 0.415 kg/kWh = 17,500 kWh → 7,262.5 kg = 7.2625 t → 7.263 t.
    const report = computeCarbonReport({
      ...BASE,
      deliveredEnergyWh: 17_500_000n,
      baselineEnergyWh: 18_000_000n,
      emissionFactor: { ...FACTOR, kgCo2ePerKwh: '0.415' },
    });
    expect(report.avoidedTco2e).toBe('7.263');
  });
});
