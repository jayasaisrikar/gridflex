/**
 * Scope 2 carbon MRV.
 *
 * Converts metered, verified energy into carbon accounting terms: the shifted
 * energy multiplied by a DECLARED grid emission factor yields avoided
 * Location-Based Scope 2 emissions, sealed with the same canonicalization as
 * every other certified document.
 *
 * The governing rule is the same as the rest of the engine: no number is
 * inferred. The emission factor is a versioned input with a cited source —
 * never a hard-coded constant — because the national MRV factor has not been
 * published (MOCCAE, Product & Build Doc) and the factor a verifier accepts
 * must be traceable to whatever is declared at issuance time.
 *
 * Both energies are NET delivered figures already: consumption above baseline
 * never counts as negative delivery (see mrv/computeMrv), so avoided carbon
 * can never exceed what the metered reduction supports.
 */

import { canonicalSha256 } from '../canonical-json/index.js';

export const CARBON_MRV_VERSION = 'gridflex-carbon-1.0.0';

/** Carbon intensity, kgCO2e per kWh. Decimal string, precision preserved. */
export type KgCo2ePerKwh = string;

export interface GridEmissionFactor {
  readonly kgCo2ePerKwh: KgCo2ePerKwh;
  /** Who declared this factor and for which grid. */
  readonly source: string;
  /** Publication or dataset version the factor came from. */
  readonly version: string;
  readonly [key: string]: string;
}

export interface CarbonReportInput {
  /** Net delivered energy from computeMrv, Wh. Must be non-negative. */
  readonly deliveredEnergyWh: bigint;
  /** Energy that would have been consumed on the baseline, Wh. Non-negative. */
  readonly baselineEnergyWh: bigint;
  readonly emissionFactor: GridEmissionFactor;
  /** Reporting period the energies cover. */
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly facilityId: string;
  readonly drillId: string;
  /** Hash of the evidence bundle this report is computed from. */
  readonly evidenceSha256: string;
}

export interface CarbonReport {
  readonly methodologyVersion: string;
  readonly scope: 'SCOPE_2_LOCATION_BASED';
  readonly facilityId: string;
  readonly drillId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Net delivered energy, kWh as a decimal string. */
  readonly deliveredEnergyKwh: string;
  readonly emissionFactor: GridEmissionFactor;
  /** Avoided emissions, tCO2e as a decimal string. */
  readonly avoidedTco2e: string;
  /** Counterfactual baseline emissions, tCO2e as a decimal string. */
  readonly baselineTco2e: string;
  readonly evidenceSha256: string;
  /** SHA-256 over this report's canonical form. */
  readonly reportSha256: string;
}

export class CarbonInputError extends Error {
  public readonly code = 'CARBON_INPUT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'CarbonInputError';
  }
}

/** Wh → kWh as an exact decimal string (three places, no float arithmetic). */
function whToKwhString(wh: bigint): string {
  const negative = wh < 0n;
  const magnitude = negative ? -wh : wh;
  const whole = magnitude / 1000n;
  const fraction = magnitude % 1000n;
  const sign = negative ? '-' : '';
  return `${sign}${whole}.${fraction.toString().padStart(3, '0')}`;
}

/**
 * Integer-scaled product of a decimal-string factor and an energy amount.
 *
 * factor(3 dp) × kWh(3 dp) → kg with 6 implied decimals, then ÷ 1,000,000 back
 * to 3-dp kg. Everything stays in BigInt until the single final string render,
 * so no float ever touches a certified figure.
 */
function multiplyDecimalKwh(
  factorKgPerKwh: KgCo2ePerKwh,
  energyKwh: string,
): string {
  const [fWhole = '0', fFrac = ''] = factorKgPerKwh.split('.');
  const [eWhole = '0', eFrac = ''] = energyKwh.split('.');
  if (!/^\d+$/.test(fWhole) || !/^\d{1,3}$/.test(fFrac)) {
    throw new CarbonInputError(`Emission factor "${factorKgPerKwh}" is not a valid decimal`);
  }
  if (!/^\d+$/.test(eWhole) || !/^\d{1,3}$/.test(eFrac)) {
    throw new CarbonInputError(`Energy "${energyKwh}" is not a valid decimal`);
  }

  const factorMicro =
    BigInt(fWhole) * 1_000_000n + BigInt(fFrac.padEnd(3, '0')) * 1_000n;
  const energyMilli = BigInt(eWhole) * 1_000n + BigInt(eFrac.padEnd(3, '0'));

  // factor is kg/kWh scaled by 1e6; energy is kWh scaled by 1e3. The product
  // is kg scaled by 1e9 (nano-kg). One kg-with-3-decimals step is 1e6
  // nano-kg, so shift six of the nine decimals out and round the remainder.
  const productNanoKg = factorMicro * energyMilli;
  const kgWith3dp = productNanoKg / 1_000_000n;
  const remainder = productNanoKg % 1_000_000n;
  const roundedUp = remainder * 2n >= 1_000_000n ? 1n : 0n;
  const totalKg3dp = kgWith3dp + roundedUp;

  const kgWhole = totalKg3dp / 1000n;
  const kgFrac = totalKg3dp % 1000n;
  return `${kgWhole}.${kgFrac.toString().padStart(3, '0')}`;
}

/** kg (3 dp decimal string) → t (3 dp decimal string). */
function kgToTonnes(kg: string): string {
  const [whole = '0', frac = ''] = kg.split('.');
  const totalKg3dp = BigInt(whole) * 1000n + BigInt((frac ?? '0').padEnd(3, '0'));
  // kg with 3 dp → tonnes with 3 dp is a shift of exactly 3 decimal places.
  const t3dp = totalKg3dp / 1000n;
  const remainder = totalKg3dp % 1000n;
  const roundedUp = remainder * 2n >= 1000n ? 1n : 0n;
  const totalT3dp = t3dp + roundedUp;
  const tWhole = totalT3dp / 1000n;
  const tFrac = totalT3dp % 1000n;
  return `${tWhole}.${tFrac.toString().padStart(3, '0')}`;
}

export function computeCarbonReport(input: CarbonReportInput): CarbonReport {
  if (input.deliveredEnergyWh < 0n) {
    throw new CarbonInputError('Delivered energy may not be negative');
  }
  if (input.baselineEnergyWh < 0n) {
    throw new CarbonInputError('Baseline energy may not be negative');
  }
  if (input.baselineEnergyWh < input.deliveredEnergyWh) {
    throw new CarbonInputError(
      'Baseline energy may not be below delivered energy; the MRV engine never netts consumption',
    );
  }

  const deliveredEnergyKwh = whToKwhString(input.deliveredEnergyWh);
  const baselineEnergyKwh = whToKwhString(input.baselineEnergyWh);

  const avoidedKg = multiplyDecimalKwh(input.emissionFactor.kgCo2ePerKwh, deliveredEnergyKwh);
  const baselineKg = multiplyDecimalKwh(input.emissionFactor.kgCo2ePerKwh, baselineEnergyKwh);

  const report = {
    methodologyVersion: CARBON_MRV_VERSION,
    scope: 'SCOPE_2_LOCATION_BASED' as const,
    facilityId: input.facilityId,
    drillId: input.drillId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    deliveredEnergyKwh,
    emissionFactor: input.emissionFactor,
    avoidedTco2e: kgToTonnes(avoidedKg),
    baselineTco2e: kgToTonnes(baselineKg),
    evidenceSha256: input.evidenceSha256,
  };

  return {
    ...report,
    reportSha256: canonicalSha256(report),
  };
}
