import { describe, expect, it } from 'vitest';
import {
  CanonicalizationError,
  canonicalSha256,
  canonicalStringify,
  sealDocument,
  verifyDocument,
} from '../src/canonical-json/index.js';

describe('canonicalStringify', () => {
  it('sorts object keys recursively so insertion order cannot change the hash', () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalStringify(a)).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalStringify({ a: [1, 2] })).toBe('{"a":[1,2]}');
  });

  it('preserves array order, which is significant', () => {
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('normalizes timestamps to UTC RFC 3339 with Z', () => {
    expect(canonicalStringify({ t: '2026-07-21T14:00:00+02:00' })).toBe('{"t":"2026-07-21T12:00:00Z"}');
    expect(canonicalStringify({ t: '2026-07-21T12:00:00.000Z' })).toBe('{"t":"2026-07-21T12:00:00Z"}');
    expect(canonicalStringify({ t: new Date('2026-07-21T12:00:00Z') })).toBe(
      '{"t":"2026-07-21T12:00:00Z"}',
    );
  });

  it('leaves non-timestamp strings untouched', () => {
    expect(canonicalStringify({ s: 'facility.active_power_kw' })).toBe(
      '{"s":"facility.active_power_kw"}',
    );
  });

  it('renders bigint as a decimal string so exactness survives serialization', () => {
    expect(canonicalStringify({ wh: 245_000n })).toBe('{"wh":"245000"}');
  });

  it('omits undefined properties instead of emitting null', () => {
    // "not applicable" and "explicitly null" must stay distinguishable.
    expect(canonicalStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalStringify({ a: 1, b: null })).toBe('{"a":1,"b":null}');
  });

  it('rejects non-integer numbers, which have no portable representation', () => {
    expect(() => canonicalStringify({ kw: 1600.25 })).toThrow(CanonicalizationError);
    expect(() => canonicalStringify({ kw: 1600.25 })).toThrow(/decimal string/);
  });

  it('accepts precision-sensitive decimals as strings', () => {
    expect(canonicalStringify({ kw: '1600.250' })).toBe('{"kw":"1600.250"}');
  });

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalStringify({ v: Number.NaN })).toThrow(/Non-finite/);
    expect(() => canonicalStringify({ v: Number.POSITIVE_INFINITY })).toThrow(/Non-finite/);
  });

  it('reports the path of the offending value', () => {
    expect(() => canonicalStringify({ envelope: { mechanisms: [{ kw: 1.5 }] } })).toThrow(
      /envelope\.mechanisms\[0\]\.kw/,
    );
  });
});

describe('canonicalSha256', () => {
  it('matches an externally reproducible digest', () => {
    // These are plain SHA-256 digests of the exact canonical UTF-8 bytes, so a
    // reviewer can verify them with any tool:
    //   printf '{"a":1}' | shasum -a 256
    // Locking them guards against an accidental change to the canonicalization
    // rules, which would silently break every previously issued Passport.
    expect(canonicalSha256({ a: 1 })).toBe(
      '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
    );
    expect(canonicalSha256({})).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });

  it('produces identical hashes for semantically identical documents', () => {
    expect(canonicalSha256({ x: 1, y: 2 })).toBe(canonicalSha256({ y: 2, x: 1 }));
  });

  it('produces different hashes when any value changes', () => {
    expect(canonicalSha256({ kw: '500.000' })).not.toBe(canonicalSha256({ kw: '500.001' }));
  });
});

describe('sealDocument / verifyDocument', () => {
  it('seals a document so a reviewer can recompute the hash independently', () => {
    const sealed = sealDocument({ facility: 'lone-star-compute', deliveredWh: 245_000n });
    expect(sealed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDocument(sealed.canonicalJson, sealed.sha256).valid).toBe(true);
  });

  it('detects tampering with the sealed content', () => {
    const sealed = sealDocument({ deliveredWh: '245000' });
    const tampered = { deliveredWh: '999999' };
    const result = verifyDocument(tampered, sealed.sha256);
    expect(result.valid).toBe(false);
    expect(result.actualSha256).not.toBe(sealed.sha256);
  });

  it('accepts an uppercase expected hash', () => {
    const sealed = sealDocument({ a: 1 });
    expect(verifyDocument(sealed.canonicalJson, sealed.sha256.toUpperCase()).valid).toBe(true);
  });

  it('is byte-identical across repeated sealing', () => {
    const doc = { b: 2, a: [1, { d: 4, c: 3 }] };
    expect(sealDocument(doc).canonicalText).toBe(sealDocument(doc).canonicalText);
  });
});
