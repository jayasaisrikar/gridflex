import { describe, expect, it } from 'vitest';
import {
  divideRoundHalfAwayFromZero,
  energyWh,
  kwNumberToMilliKw,
  kwStringToMilliKw,
  medianBigInt,
  milliKwSecondsToWattHours,
  milliKwToKwString,
  performanceBps,
} from '../src/units.js';

describe('kwStringToMilliKw', () => {
  it('parses numeric(14,3) strings exactly', () => {
    expect(kwStringToMilliKw('1600.250')).toBe(1_600_250n);
    expect(kwStringToMilliKw('1600')).toBe(1_600_000n);
    expect(kwStringToMilliKw('0.001')).toBe(1n);
    expect(kwStringToMilliKw('-25.500')).toBe(-25_500n);
  });

  it('pads short fractions rather than misreading their magnitude', () => {
    // "1600.2" is 1600.200 kW, not 1600.002 kW.
    expect(kwStringToMilliKw('1600.2')).toBe(1_600_200n);
  });

  it('refuses precision it cannot represent instead of truncating silently', () => {
    expect(() => kwStringToMilliKw('1.0001')).toThrow(/more precision/);
  });

  it('rejects non-numeric input', () => {
    expect(() => kwStringToMilliKw('NaN')).toThrow(/Not a decimal power value/);
    expect(() => kwStringToMilliKw('')).toThrow(/Not a decimal power value/);
  });

  it('round-trips through milliKwToKwString', () => {
    for (const value of ['0.000', '900.000', '1600.250', '-25.500']) {
      expect(milliKwToKwString(kwStringToMilliKw(value))).toBe(value);
    }
  });
});

describe('kwNumberToMilliKw', () => {
  it('rounds half away from zero', () => {
    expect(kwNumberToMilliKw(1.0005)).toBe(1001n);
    expect(kwNumberToMilliKw(-1.0005)).toBe(-1001n);
  });

  it('rejects non-finite input', () => {
    expect(() => kwNumberToMilliKw(Number.NaN)).toThrow(/finite/);
    expect(() => kwNumberToMilliKw(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});

describe('divideRoundHalfAwayFromZero', () => {
  it('rounds halves away from zero in both directions', () => {
    expect(divideRoundHalfAwayFromZero(5n, 2n)).toBe(3n);
    expect(divideRoundHalfAwayFromZero(-5n, 2n)).toBe(-3n);
    expect(divideRoundHalfAwayFromZero(4n, 2n)).toBe(2n);
    expect(divideRoundHalfAwayFromZero(1n, 3n)).toBe(0n);
  });

  it('throws on division by zero rather than returning a sentinel', () => {
    expect(() => divideRoundHalfAwayFromZero(1n, 0n)).toThrow(/Division by zero/);
  });
});

describe('energyWh', () => {
  it('converts sustained power to watt-hours exactly', () => {
    // 1000 kW held for 3600 s = 1000 kWh = 1_000_000 Wh.
    expect(energyWh(kwNumberToMilliKw(1000), 3600)).toBe(1_000_000n);
    // 500 kW for 30 minutes = 250 kWh = 250_000 Wh — the canonical commitment.
    expect(energyWh(kwNumberToMilliKw(500), 1800)).toBe(250_000n);
  });

  it('accumulating mkW-seconds and converting once is exact', () => {
    // This is the ONLY correct way to total energy across intervals, and it is
    // what computeMrv does: accumulate exact mkW-seconds, convert to Wh at the end.
    const power = kwNumberToMilliKw(490);
    let milliKwSeconds = 0n;
    for (let i = 0; i < 30; i += 1) milliKwSeconds += power * 60n;
    expect(milliKwSecondsToWattHours(milliKwSeconds)).toBe(energyWh(power, 1800));
    expect(milliKwSecondsToWattHours(milliKwSeconds)).toBe(245_000n);
  });

  it('per-interval rounding DRIFTS — documents why the engine must not do this', () => {
    // 490 kW for 60 s is 8166.67 Wh, which rounds to 8167 each interval.
    // Summing rounded intervals overstates a 30-minute drill by 10 Wh.
    // Regression guard: if anyone refactors computeMrv to round per interval,
    // certified delivered energy silently inflates.
    const power = kwNumberToMilliKw(490);
    let summedRounded = 0n;
    for (let i = 0; i < 30; i += 1) summedRounded += energyWh(power, 60);

    expect(summedRounded).toBe(245_010n);
    expect(summedRounded).not.toBe(energyWh(power, 1800));
    expect(summedRounded - energyWh(power, 1800)).toBe(10n);
  });

  it('rejects fractional or negative durations', () => {
    expect(() => energyWh(1n, 1.5)).toThrow(/non-negative integer/);
    expect(() => energyWh(1n, -60)).toThrow(/non-negative integer/);
  });
});

describe('performanceBps', () => {
  it('computes basis points per the specified formula', () => {
    expect(performanceBps(245_000n, 250_000n)).toBe(9800);
    expect(performanceBps(250_000n, 250_000n)).toBe(10_000);
  });

  it('caps at 10000 when delivery exceeds the commitment', () => {
    expect(performanceBps(500_000n, 250_000n)).toBe(10_000);
  });

  it('refuses a zero or negative commitment', () => {
    expect(() => performanceBps(1n, 0n)).toThrow(/must be positive/);
  });
});

describe('medianBigInt', () => {
  it('returns the middle value for odd-length series', () => {
    expect(medianBigInt([3n, 1n, 2n])).toBe(2n);
  });

  it('averages the two middle values for even-length series', () => {
    expect(medianBigInt([1n, 2n, 3n, 4n])).toBe(3n); // 2.5 -> 3, half away from zero
  });

  it('does not mutate its input', () => {
    const input = [3n, 1n, 2n];
    medianBigInt(input);
    expect(input).toEqual([3n, 1n, 2n]);
  });

  it('throws on an empty series rather than returning zero', () => {
    expect(() => medianBigInt([])).toThrow(/empty series/);
  });
});
