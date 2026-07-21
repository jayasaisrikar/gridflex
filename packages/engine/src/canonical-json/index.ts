import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialization for evidence bundles and Passports (spec §15.1).
 *
 *   - UTF-8 output
 *   - object keys sorted recursively (by UTF-16 code unit, i.e. Array#sort default)
 *   - no insignificant whitespace
 *   - timestamps normalized to UTC RFC 3339 with `Z`
 *   - precision-sensitive decimals represented as strings
 *   - SHA-256 computed over the canonical bytes
 *
 * A reviewer must be able to recompute the hash independently, so this format is
 * intentionally boring and fully specified. Any change to it is a breaking change
 * to every previously issued Passport's verifiability and requires a new
 * `schema_version`.
 */

export const CANONICAL_SCHEMA_VERSION = 'gridflex-canonical-1';

/** Values permitted in a canonical document. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export type CanonicalInput =
  | string
  | number
  | boolean
  | null
  | undefined
  | bigint
  | Date
  | readonly CanonicalInput[]
  | { readonly [key: string]: CanonicalInput };

export class CanonicalizationError extends Error {
  public readonly code = 'CANONICALIZATION_FAILED';
  constructor(message: string, public readonly path: string) {
    super(`${message} (at ${path || '$'})`);
    this.name = 'CanonicalizationError';
  }
}

/**
 * Normalizes an input value into canonical form.
 *
 * Deliberate refusals — each would otherwise produce a document that hashes
 * differently across platforms or silently loses precision:
 *  - non-finite numbers (NaN/Infinity have no JSON representation)
 *  - non-integer numbers (float formatting is not portable; pass a string)
 *  - functions, symbols, undefined inside arrays
 */
export function canonicalize(value: CanonicalInput, path = ''): CanonicalValue {
  if (value === null) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new CanonicalizationError('Invalid Date cannot be canonicalized', path);
    }
    return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  switch (typeof value) {
    case 'string':
      return normalizeIfTimestamp(value);

    case 'boolean':
      return value;

    case 'bigint':
      // bigint has no JSON form; emit as a decimal string so exactness survives.
      return value.toString();

    case 'number': {
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(
          `Non-finite number ${value} cannot be canonicalized`,
          path,
        );
      }
      if (!Number.isInteger(value)) {
        throw new CanonicalizationError(
          `Non-integer number ${value} must be supplied as a decimal string to guarantee reproducible hashing`,
          path,
        );
      }
      return value;
    }

    case 'undefined':
      throw new CanonicalizationError('undefined has no canonical representation', path);

    case 'object': {
      if (Array.isArray(value)) {
        return value.map((item, index) => canonicalize(item as CanonicalInput, `${path}[${index}]`));
      }

      const source = value as { readonly [key: string]: CanonicalInput };
      const result: Record<string, CanonicalValue> = {};
      // Sorting here is what makes the hash independent of insertion order.
      for (const key of Object.keys(source).sort()) {
        const child = source[key];
        // Absent keys are omitted entirely rather than serialized as null, so
        // that "field not applicable" and "field explicitly null" stay distinct.
        if (child === undefined) continue;
        result[key] = canonicalize(child, path ? `${path}.${key}` : key);
      }
      return result;
    }

    default:
      throw new CanonicalizationError(`Unsupported value of type ${typeof value}`, path);
  }
}

const RFC3339_LIKE =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Normalizes any RFC 3339 timestamp to UTC with a `Z` suffix and no fractional
 * seconds, so the same instant always produces the same bytes regardless of the
 * offset it arrived in. Non-timestamp strings pass through untouched.
 */
function normalizeIfTimestamp(value: string): string {
  if (!RFC3339_LIKE.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Serializes to canonical JSON text: sorted keys, no insignificant whitespace. */
export function canonicalStringify(value: CanonicalInput): string {
  return JSON.stringify(canonicalize(value));
}

/** Canonical UTF-8 bytes — the exact input to the hash. */
export function canonicalBytes(value: CanonicalInput): Buffer {
  return Buffer.from(canonicalStringify(value), 'utf8');
}

/** Lowercase hex SHA-256 over the canonical bytes. */
export function canonicalSha256(value: CanonicalInput): string {
  return createHash('sha256').update(canonicalBytes(value)).digest('hex');
}

export interface CanonicalDocument {
  readonly canonicalJson: CanonicalValue;
  readonly canonicalText: string;
  readonly sha256: string;
}

/**
 * Produces the document and its hash together. Storing them as a pair (spec §15.1)
 * means a verifier never has to guess which serialization produced the digest.
 */
export function sealDocument(value: CanonicalInput): CanonicalDocument {
  const canonicalJson = canonicalize(value);
  const canonicalText = JSON.stringify(canonicalJson);
  const sha256 = createHash('sha256').update(Buffer.from(canonicalText, 'utf8')).digest('hex');
  return { canonicalJson, canonicalText, sha256 };
}

/** Recomputes the hash and reports whether the document is intact. */
export function verifyDocument(
  canonicalJson: CanonicalInput,
  expectedSha256: string,
): { valid: boolean; actualSha256: string } {
  const actualSha256 = canonicalSha256(canonicalJson);
  return { valid: actualSha256 === expectedSha256.toLowerCase(), actualSha256 };
}
