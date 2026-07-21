/**
 * Exact unit arithmetic for the assurance engine.
 *
 * Spec §14: "Unit tests use Decimal or integer Wh where possible; do not depend
 * on floating-point equality." Every certified energy number in GridFlex is
 * derived through this module using bigint, so a Passport's delivered energy is
 * reproducible bit-for-bit on any machine.
 *
 * Internal representation:
 *   - Power is milli-kilowatts (mkW): 1 kW = 1000 mkW. Integer.
 *   - Energy accumulates as mkW-seconds, then converts to whole Wh.
 */

/** Power in milli-kilowatts. 1 kW === 1000 mkW. */
export type MilliKw = bigint;

/** Energy in whole watt-hours. */
export type WattHours = bigint;

const MKW_PER_KW = 1000n;

/**
 * Parses a decimal power string (e.g. "1600.250" from a numeric column) into
 * exact milli-kilowatts. Rejects anything finer than 3 decimal places rather
 * than silently truncating a value the caller believed was preserved.
 */
export function kwStringToMilliKw(value: string): MilliKw {
  const trimmed = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new RangeError(`Not a decimal power value: ${JSON.stringify(value)}`);
  }
  const [, sign = '', whole = '0', fraction = ''] = match;
  if (fraction.length > 3) {
    throw new RangeError(
      `Power value ${JSON.stringify(value)} has more precision than milli-kilowatts can represent without loss`,
    );
  }
  const scaledFraction = fraction.padEnd(3, '0');
  const magnitude = BigInt(whole) * MKW_PER_KW + BigInt(scaledFraction);
  return sign === '-' ? -magnitude : magnitude;
}

/** Converts a JS number of kW to exact milli-kilowatts, rounding half away from zero. */
export function kwNumberToMilliKw(value: number): MilliKw {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Power value must be finite, received ${value}`);
  }
  const scaled = value * 1000;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return BigInt(rounded);
}

/** Renders milli-kilowatts as a fixed 3-decimal string, matching numeric(14,3). */
export function milliKwToKwString(value: MilliKw): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / MKW_PER_KW;
  const fraction = magnitude % MKW_PER_KW;
  return `${negative ? '-' : ''}${whole}.${fraction.toString().padStart(3, '0')}`;
}

/**
 * Converts sustained power over a duration into whole watt-hours.
 *
 *   1 kW·s = 1000 J = 1000/3600 Wh = 5/18 Wh
 *   mkW·s  = kW·s / 1000
 *   => Wh   = mkW·s × 5 / 18000
 *
 * Rounds half away from zero at the final step only — no intermediate rounding.
 */
export function milliKwSecondsToWattHours(milliKwSeconds: bigint): WattHours {
  const numerator = milliKwSeconds * 5n;
  const denominator = 18_000n;
  return divideRoundHalfAwayFromZero(numerator, denominator);
}

/** Energy delivered by holding `power` for `seconds`. */
export function energyWh(power: MilliKw, seconds: number): WattHours {
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new RangeError(`Interval seconds must be a non-negative integer, received ${seconds}`);
  }
  return milliKwSecondsToWattHours(power * BigInt(seconds));
}

/** Exact integer division rounding halves away from zero. */
export function divideRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Performance in basis points, capped at 10000 per spec §14:
 *   performance_bps = min(10000, delivered_wh × 10000 / committed_energy_wh)
 */
export function performanceBps(delivered: WattHours, committed: WattHours): number {
  if (committed <= 0n) {
    throw new RangeError('Committed energy must be positive to compute performance');
  }
  const raw = divideRoundHalfAwayFromZero(delivered * 10_000n, committed);
  const capped = raw > 10_000n ? 10_000n : raw < 0n ? 0n : raw;
  return Number(capped);
}

/** Exact median of a bigint series. Even-length medians round half away from zero. */
export function medianBigInt(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new RangeError('Median of an empty series is undefined');
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) {
    return sorted[middle] as bigint;
  }
  const lower = sorted[middle - 1] as bigint;
  const upper = sorted[middle] as bigint;
  return divideRoundHalfAwayFromZero(lower + upper, 2n);
}

export function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function minBigInt(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new RangeError('Minimum of an empty set is undefined');
  return values.reduce((acc, value) => (value < acc ? value : acc));
}
