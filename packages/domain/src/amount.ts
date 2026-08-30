import { type Brand, type Parsed, err, ok } from './brand.js';

/**
 * A token quantity in base units (the smallest indivisible unit of the token).
 *
 * Backed by bigint. There is deliberately no `number` API on this type: a
 * float can silently lose precision above 2^53 and a lost wei is a wrong
 * verdict (CLAUDE.md 4, docs/DATA_MODEL.md 2.2).
 */
export type Amount = Brand<bigint, 'Amount'>;

/** Number of decimals a token declares. EVM tokens are capped at 77 by uint256 range. */
export type Decimals = Brand<number, 'Decimals'>;

/** Largest value representable by an EVM uint256. */
export const MAX_UINT256 = (1n << 256n) - 1n;

const DECIMAL_STRING = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

export const parseDecimals = (raw: number): Parsed<Decimals> => {
  if (typeof raw !== 'number' || !Number.isInteger(raw))
    return err(`Decimals: expected an integer, got ${String(raw)}`);
  if (raw < 0 || raw > 77) return err(`Decimals: must be within 0..77, got ${String(raw)}`);
  return ok(raw as Decimals);
};

/**
 * Build an Amount from base units.
 *
 * Accepts bigint or a canonical decimal string. `number` is rejected on purpose,
 * including safe-range integers: allowing it would make the unsafe call site
 * indistinguishable from the safe one at review time.
 */
export const parseAmount = (raw: bigint | string): Parsed<Amount> => {
  let v: bigint;
  if (typeof raw === 'bigint') {
    v = raw;
  } else if (typeof raw === 'string') {
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
      return err(`Amount: expected canonical base-unit decimal string, got ${JSON.stringify(raw)}`);
    }
    v = BigInt(raw);
  } else {
    return err(`Amount: expected bigint or decimal string, got ${typeof raw}`);
  }
  if (v < 0n) return err(`Amount: must be non-negative, got ${v.toString()}`);
  if (v > MAX_UINT256) return err(`Amount: exceeds uint256 maximum`);
  return ok(v as Amount);
};

/** Canonical serialization: a base-unit decimal string. Stable across round-trips. */
export const amountToBaseUnitString = (a: Amount): string => (a as bigint).toString(10);

/**
 * Human-readable rendering at a given scale. Returns a string, never a number.
 * Purely presentational; the base-unit value stays the source of truth.
 */
export const amountToDecimalString = (a: Amount, decimals: Decimals): string => {
  const d = decimals as number;
  const v = a as bigint;
  if (d === 0) return v.toString(10);
  const s = v.toString(10).padStart(d + 1, '0');
  const whole = s.slice(0, s.length - d);
  const frac = s.slice(s.length - d).replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac}` : whole;
};

/**
 * Parse a human-scale decimal string into base units at the given scale.
 * Rejects anything that would need rounding: an operator-visible error beats a
 * silently truncated liability.
 */
export const parseAmountAtScale = (raw: string, decimals: Decimals): Parsed<Amount> => {
  if (typeof raw !== 'string') return err(`Amount: expected a string, got ${typeof raw}`);
  if (!DECIMAL_STRING.test(raw))
    return err(`Amount: not a canonical decimal string: ${JSON.stringify(raw)}`);
  const d = decimals as number;
  const [whole = '0', frac = ''] = raw.split('.');
  if (frac.length > d) {
    return err(
      `Amount: ${String(frac.length)} fractional digits exceed the token scale of ${String(d)}`,
    );
  }
  return parseAmount(BigInt(whole + frac.padEnd(d, '0')));
};

export const addAmount = (a: Amount, b: Amount): Parsed<Amount> =>
  parseAmount((a as bigint) + (b as bigint));

/** Saturating-free subtraction: underflow is an error, not a wrap or a clamp. */
export const subAmount = (a: Amount, b: Amount): Parsed<Amount> =>
  parseAmount((a as bigint) - (b as bigint));

export const compareAmount = (a: Amount, b: Amount): -1 | 0 | 1 => {
  const x = a as bigint;
  const y = b as bigint;
  return x < y ? -1 : x > y ? 1 : 0;
};
