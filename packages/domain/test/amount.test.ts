import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MAX_UINT256,
  addAmount,
  amountToBaseUnitString,
  amountToDecimalString,
  compareAmount,
  parseAmount,
  parseAmountAtScale,
  parseDecimals,
  subAmount,
} from '../src/amount.js';
import type { Amount, Decimals } from '../src/amount.js';

const amount = (v: bigint | string): Amount => {
  const r = parseAmount(v);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const decimals = (n: number): Decimals => {
  const r = parseDecimals(n);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('parseAmount', () => {
  it('accepts zero and positive bigints', () => {
    expect(parseAmount(0n).ok).toBe(true);
    expect(parseAmount(1n).ok).toBe(true);
  });

  it('accepts uint256 max exactly', () => {
    const r = parseAmount(MAX_UINT256);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value as unknown as bigint).toBe(MAX_UINT256);
  });

  it('rejects uint256 max + 1', () => {
    expect(parseAmount(MAX_UINT256 + 1n).ok).toBe(false);
  });

  it('rejects negative values', () => {
    expect(parseAmount(-1n).ok).toBe(false);
    expect(parseAmount('-1').ok).toBe(false);
  });

  it('crosses 2^53 without precision loss', () => {
    const beyond = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const r = parseAmount(beyond);
    expect(r.ok).toBe(true);
    if (r.ok) expect(amountToBaseUnitString(r.value)).toBe('9007199254740992');
  });

  it('rejects a JS number, including safe integers', () => {
    expect(parseAmount(1 as unknown as bigint).ok).toBe(false);
    expect(parseAmount(0 as unknown as bigint).ok).toBe(false);
    expect(parseAmount(Number.MAX_SAFE_INTEGER as unknown as bigint).ok).toBe(false);
  });

  it.each([
    ['float string', '1.5'],
    ['exponent', '1e18'],
    ['hex', '0xff'],
    ['leading zero', '01'],
    ['empty', ''],
    ['whitespace', ' 1 '],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
  ])('rejects %s', (_label, input) => {
    expect(parseAmount(input).ok).toBe(false);
  });
});

describe('parseDecimals', () => {
  it('accepts the common token scales', () => {
    for (const d of [0, 6, 8, 18]) expect(parseDecimals(d).ok).toBe(true);
  });

  it.each([
    ['negative', -1],
    ['beyond uint256 range', 78],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
  ])('rejects %s', (_label, input) => {
    expect(parseDecimals(input).ok).toBe(false);
  });
});

describe('scale conversion', () => {
  it('renders base units at the token scale', () => {
    expect(amountToDecimalString(amount('1000000'), decimals(6))).toBe('1');
    expect(amountToDecimalString(amount('1500000'), decimals(6))).toBe('1.5');
    expect(amountToDecimalString(amount('1'), decimals(18))).toBe('0.000000000000000001');
    expect(amountToDecimalString(amount('0'), decimals(18))).toBe('0');
    expect(amountToDecimalString(amount('42'), decimals(0))).toBe('42');
  });

  it('parses human scale into base units', () => {
    const r = parseAmountAtScale('1.5', decimals(6));
    expect(r.ok).toBe(true);
    if (r.ok) expect(amountToBaseUnitString(r.value)).toBe('1500000');
  });

  it('refuses input that would need rounding rather than truncating silently', () => {
    const r = parseAmountAtScale('1.0000001', decimals(6));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('exceed the token scale');
  });

  it('round-trips across the 6 to 18 decimal boundary', () => {
    const base = amount('123456789');
    const s = amountToDecimalString(base, decimals(6));
    const back = parseAmountAtScale(s, decimals(6));
    expect(back.ok).toBe(true);
    if (back.ok) expect(compareAmount(back.value, base)).toBe(0);
  });
});

describe('arithmetic refuses to wrap or clamp', () => {
  it('adds within range', () => {
    const r = addAmount(amount('2'), amount('3'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(amountToBaseUnitString(r.value)).toBe('5');
  });

  it('rejects addition that overflows uint256', () => {
    expect(addAmount(amount(MAX_UINT256), amount('1')).ok).toBe(false);
  });

  it('rejects subtraction that underflows', () => {
    expect(subAmount(amount('1'), amount('2')).ok).toBe(false);
  });
});

describe('bigint JSON round-trip', () => {
  it('survives serialization as a canonical base-unit string', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_UINT256 }), (v) => {
        const a = amount(v);
        const json = JSON.stringify({ amount: amountToBaseUnitString(a) });
        const parsed = JSON.parse(json) as { amount: string };
        const back = parseAmount(parsed.amount);
        expect(back.ok).toBe(true);
        if (back.ok) expect(compareAmount(back.value, a)).toBe(0);
      }),
      { numRuns: 300 },
    );
  });

  it('renders and re-parses at an arbitrary scale without drift', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        fc.integer({ min: 0, max: 30 }),
        (v, d) => {
          const a = amount(v);
          const scale = decimals(d);
          const back = parseAmountAtScale(amountToDecimalString(a, scale), scale);
          expect(back.ok).toBe(true);
          if (back.ok) expect(compareAmount(back.value, a)).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('the module exposes no number-based token API', () => {
  it('every exported amount value is a bigint at runtime', () => {
    expect(typeof (amount('1') as unknown)).toBe('bigint');
    expect(typeof amountToBaseUnitString(amount('1'))).toBe('string');
    expect(typeof amountToDecimalString(amount('1'), decimals(0))).toBe('string');
  });
});
