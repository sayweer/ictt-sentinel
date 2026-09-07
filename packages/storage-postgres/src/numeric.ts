import { type Amount, type Parsed, err, ok, parseAmount } from '@ictt-sentinel/domain';

/**
 * Lossless bridge between PostgreSQL `NUMERIC(78,0)` and the domain `Amount`.
 *
 * The driver returns NUMERIC as a string precisely so that no float ever exists
 * on the path, and this module is the only place allowed to cross that boundary.
 * There is no `number` overload in either direction: a value that has already
 * been through a double has lost the low bits before it reaches us, and a lost
 * base unit is a wrong verdict (docs/DATA_MODEL.md 2.2).
 */

/** 78 decimal digits is exactly what uint256 needs, and what the column declares. */
const NUMERIC_78_0 = /^(0|[1-9][0-9]{0,77})$/;

/**
 * Encode for the wire. The value is already a checked base-unit bigint, so this
 * is a total function; it exists so call sites never hand a bigint straight to
 * the driver and get an implicit conversion.
 */
export const amountToColumn = (a: Amount): string => (a as bigint).toString(10);

/**
 * Decode a NUMERIC column back into an Amount.
 *
 * Rejects anything the column should not have been able to hold - a scale
 * separator, a sign, an exponent - rather than coercing. Reaching one of those
 * means the column type or a cast is wrong, and silently rounding it away is the
 * exact failure this type exists to prevent.
 */
export const columnToAmount = (raw: unknown): Parsed<Amount> => {
  if (typeof raw === 'bigint') return parseAmount(raw);
  if (typeof raw !== 'string') {
    return err(`NUMERIC column: expected a string from the driver, got ${typeof raw}`);
  }
  if (!NUMERIC_78_0.test(raw)) {
    return err(`NUMERIC column: not a canonical 78-digit integer: ${JSON.stringify(raw)}`);
  }
  return parseAmount(raw);
};

/**
 * Encode a bigint for a `bigint`/`numeric` column.
 *
 * The driver has no bigint parameter type, and the alternative - handing it a JS
 * number - is exactly the truncation this package exists to prevent. Sending the
 * decimal text lets PostgreSQL do the widening with full precision.
 */
export const bigintToColumn = (v: bigint): string => v.toString(10);

/**
 * Decode a `bigint`-typed column (block heights, counts).
 *
 * PostgreSQL `bigint` also arrives as a string, and `Number()` on it would start
 * lying above 2^53, so the conversion goes through BigInt without exception.
 */
export const columnToBigint = (raw: unknown): Parsed<bigint> => {
  if (typeof raw === 'bigint') return ok(raw);
  if (typeof raw === 'number') {
    // Reachable only if a column type was changed to int4; fail loudly instead of
    // accepting a value that may already have been truncated.
    return err('bigint column: driver returned a JS number, which cannot be trusted for int8');
  }
  if (typeof raw !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(raw)) {
    return err(`bigint column: not a canonical integer: ${JSON.stringify(raw)}`);
  }
  return ok(BigInt(raw));
};
