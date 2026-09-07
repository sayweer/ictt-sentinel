/**
 * Canonical JSON.
 *
 * Two machines that observed the same chain state must produce byte-identical
 * evidence. Ordinary `JSON.stringify` does not give that: object key order
 * follows insertion, numbers go through doubles, and Unicode can be encoded two
 * different ways for the same text. Each of those would silently break the
 * reproducibility promise, so each is pinned here.
 */

/** Values a canonical document may contain. Note the absence of `number`. */
export type CanonicalValue =
  | string
  | boolean
  | null
  | bigint
  | readonly CanonicalValue[]
  | { readonly [k: string]: CanonicalValue };

export class NonCanonicalValueError extends Error {
  override readonly name = 'NonCanonicalValueError';
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`value at ${path} cannot be canonicalised: ${detail}`);
    this.path = path;
  }
}

/**
 * Serialise deterministically.
 *
 *   - object keys sorted by code unit, recursively;
 *   - bigint as a canonical decimal string, because JSON numbers are doubles
 *     and a wei above 2^53 would come back wrong;
 *   - strings normalised to NFC, so the same text has one encoding;
 *   - `number` REJECTED outright: a float in an accounting document is a bug,
 *     and silently stringifying it would hide that;
 *   - `undefined` rejected, since "absent" and "present but undefined" must not
 *     hash the same.
 */
export const canonicalise = (value: unknown, path = '$'): string => {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.normalize('NFC'));
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      // Quoted: a bare decimal would be read back as a double by any consumer.
      return JSON.stringify(value.toString(10));
    case 'number':
      throw new NonCanonicalValueError(
        path,
        'numbers are doubles; use a bigint or a decimal string',
      );
    case 'undefined':
      throw new NonCanonicalValueError(path, 'undefined is not distinguishable from absent');
    case 'function':
    case 'symbol':
      throw new NonCanonicalValueError(path, `${typeof value} has no canonical form`);
    case 'object':
      // Arrays and plain objects are handled below; falling through keeps the
      // switch exhaustive without duplicating that logic here.
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map((v, i) => canonicalise(v, `${path}[${String(i)}]`)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  // Sorted by code unit, so insertion order cannot change the bytes.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = entries
    .map(([k, v]) => `${JSON.stringify(k.normalize('NFC'))}:${canonicalise(v, `${path}.${k}`)}`)
    .join(',');
  return `{${body}}`;
};

/**
 * Convert an ordinary object graph into canonical values.
 *
 * `number` is converted only where it is genuinely an integer count (array
 * lengths, indices); anything fractional is refused rather than rounded.
 */
export const toCanonicalValue = (value: unknown, path = '$'): CanonicalValue => {
  if (value === null) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new NonCanonicalValueError(path, 'fractional numbers have no canonical form');
    }
    if (!Number.isSafeInteger(value)) {
      throw new NonCanonicalValueError(path, 'integer is outside the safe range');
    }
    // Integer counts become strings so the document has no JSON numbers at all.
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => toCanonicalValue(v, `${path}[${String(i)}]`));
  }
  if (typeof value === 'object') {
    const out: Record<string, CanonicalValue> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = toCanonicalValue(v, `${path}.${k}`);
    }
    return out;
  }
  throw new NonCanonicalValueError(path, `${typeof value} has no canonical form`);
};

/** Canonical string for any supported graph. The input to the content hash. */
export const canonicalStringify = (value: unknown): string => canonicalise(toCanonicalValue(value));
