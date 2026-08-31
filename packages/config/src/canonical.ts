import { createHash } from 'node:crypto';

/**
 * Canonical digest of a configuration document.
 *
 * Every evaluation is bound to the manifest and policy it was produced under,
 * so the digest has to be stable against things that carry no meaning: key
 * order, YAML comments, indentation and quoting style. It must also be
 * independent of any resolved secret, because the same deployment checked from
 * two machines has to hash identically (docs/DATA_MODEL.md 4).
 */

/** Values that survive `parseSafeYaml`. */
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Deterministic serialisation: object keys sorted by code unit, no whitespace.
 * Arrays keep their order, because order is meaning in a list of endpoints.
 */
export const canonicalize = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('cannot canonicalize a non-finite number');
    // Integers only: a float in a config document is a bug we would rather not
    // hash into an evidence identity.
    if (!Number.isInteger(value)) throw new TypeError('cannot canonicalize a fractional number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = value[k];
      // An explicit `undefined` is absence, not a value; skipping it keeps a
      // document that omits a field identical to one that nulls it out.
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${canonicalize(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new TypeError(`cannot canonicalize a value of type ${typeof value}`);
};

/** `sha256:<hex>` over the canonical form. */
export const canonicalDigest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')}`;

export type { Json };
