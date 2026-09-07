import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MAX_UINT256, removeTokenScale } from '@ictt-sentinel/ictt-adapters';
import { toHomeUnits } from '../src/gate-b.js';

/**
 * Differential test against the pinned `TokenScalingUtils` port.
 *
 * `invariant-core` is layer 0 and may not import `@ictt-sentinel/ictt-adapters`,
 * so the remote-to-home conversion exists twice. That duplication is only safe
 * while the two agree exactly, and this file is what makes that a checked fact
 * rather than an assumption: the FLOOR arm must equal `removeTokenScale` for
 * every input, including the ones that revert on chain.
 *
 * If this ever fails, the accounting engine and the adapter have drifted apart
 * and one of them is silently producing a different liability.
 */

const multipliers = fc.oneof(
  fc.constant(1n),
  fc.constant(10n ** 12n),
  fc.constant(10n ** 6n),
  fc.bigInt({ min: 1n, max: 10n ** 18n }),
);

describe('toHomeUnits floor matches the pinned removeTokenScale', () => {
  it('agrees on the dividing direction', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_UINT256 }), multipliers, (amount, multiplier) => {
        const ours = toHomeUnits(amount, multiplier, true);
        const theirs = removeTokenScale(multiplier, true, amount);
        expect(ours.ok).toBe(theirs.ok);
        if (ours.ok && theirs.ok) expect(ours.floor).toBe(theirs.value);
      }),
      { numRuns: 500 },
    );
  });

  it('agrees on the multiplying direction, including the overflow refusal', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_UINT256 }), multipliers, (amount, multiplier) => {
        const ours = toHomeUnits(amount, multiplier, false);
        const theirs = removeTokenScale(multiplier, false, amount);
        // Both must refuse rather than wrap when the product leaves uint256.
        expect(ours.ok).toBe(theirs.ok);
        if (ours.ok && theirs.ok) {
          expect(ours.floor).toBe(theirs.value);
          expect(ours.ceil).toBe(theirs.value);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('agrees at the 6 <-> 18 decimal boundaries the product actually ships', () => {
    const m = 10n ** 12n;
    for (const amount of [0n, 1n, m - 1n, m, m + 1n, 999_999n * m, MAX_UINT256]) {
      const ours = toHomeUnits(amount, m, true);
      const theirs = removeTokenScale(m, true, amount);
      expect(ours.ok && theirs.ok && ours.floor === theirs.value).toBe(true);
    }
  });

  it('never returns a ceiling below the floor, or more than one above it', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: MAX_UINT256 }),
        multipliers,
        fc.boolean(),
        (amount, multiplier, multiplyOnRemote) => {
          const r = toHomeUnits(amount, multiplier, multiplyOnRemote);
          if (!r.ok) return;
          // Dust is at most one base unit: it comes from a single truncation.
          expect(r.ceil).toBeGreaterThanOrEqual(r.floor);
          expect(r.ceil - r.floor).toBeLessThanOrEqual(1n);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('rounds up exactly when the division leaves a remainder', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (amount, multiplier) => {
          const r = toHomeUnits(amount, multiplier, true);
          if (!r.ok) return;
          const exact = amount % multiplier === 0n;
          expect(r.ceil).toBe(exact ? r.floor : r.floor + 1n);
        },
      ),
      { numRuns: 500 },
    );
  });
});
