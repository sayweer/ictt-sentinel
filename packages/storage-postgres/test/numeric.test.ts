import { describe, expect, it } from 'vitest';
import { MAX_UINT256, parseAmount } from '@ictt-sentinel/domain';
import { amountToColumn, bigintToColumn, columnToAmount, columnToBigint } from '../src/numeric.js';

const amount = (v: bigint | string) => {
  const parsed = parseAmount(v);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

describe('amount <-> NUMERIC(78,0)', () => {
  it('round-trips uint256 max without loss', () => {
    const max = amount(MAX_UINT256);
    const encoded = amountToColumn(max);
    expect(encoded).toBe(MAX_UINT256.toString(10));
    expect(encoded).toHaveLength(78);

    const decoded = columnToAmount(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value as bigint).toBe(MAX_UINT256);
  });

  it('round-trips a value that a double would have rounded', () => {
    // 2^53 + 1 is the smallest integer a float64 cannot represent.
    const awkward = (1n << 53n) + 1n;
    const decoded = columnToAmount(amountToColumn(amount(awkward)));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value as bigint).toBe(awkward);
    // The failure this guards against, stated explicitly.
    expect(BigInt(Number(awkward))).not.toBe(awkward);
  });

  it('rejects a JS number from the driver rather than coercing it', () => {
    const decoded = columnToAmount(1234);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error).toContain('expected a string');
  });

  it.each([
    ['1.5', 'a scale separator'],
    ['-1', 'a sign'],
    ['1e18', 'an exponent'],
    ['', 'an empty string'],
    ['01', 'a leading zero'],
  ])('rejects %s (%s)', (raw) => {
    expect(columnToAmount(raw).ok).toBe(false);
  });

  it('rejects a 79-digit value that the column could not have held', () => {
    expect(columnToAmount('9'.repeat(79)).ok).toBe(false);
  });

  it('rejects a value above uint256 even at 78 digits', () => {
    const overMax = (MAX_UINT256 + 1n).toString(10);
    expect(columnToAmount(overMax).ok).toBe(false);
  });
});

describe('bigint columns', () => {
  it('encodes a height above 2^53 as exact decimal text', () => {
    const height = 9_007_199_254_740_993n;
    expect(bigintToColumn(height)).toBe('9007199254740993');
  });

  it('decodes int8 text without going through a double', () => {
    const decoded = columnToBigint('9007199254740993');
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value).toBe(9_007_199_254_740_993n);
  });

  it('refuses a number, because it may already have been truncated', () => {
    // Written via Number() because the literal itself cannot survive the parser:
    // that is precisely the truncation this rejection exists to catch.
    const decoded = columnToBigint(Number('9007199254740993'));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error).toContain('cannot be trusted');
  });

  it('accepts a negative int8 (deltas), unlike an Amount', () => {
    const decoded = columnToBigint('-42');
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value).toBe(-42n);
    expect(columnToAmount('-42').ok).toBe(false);
  });
});
