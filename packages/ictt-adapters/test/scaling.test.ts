import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MAX_TOKEN_DECIMALS,
  MAX_UINT256,
  applyTokenScale,
  deriveCollateralNeeded,
  deriveTokenMultiplierValues,
  removeTokenScale,
} from '../src/scaling.js';
import { SOURCE_FACTS } from './provenance.js';

/**
 * Differential reference.
 *
 * Written straight from the Solidity text rather than from the port, so the two
 * are independent statements of the same rule. If the port drifts, the property
 * runs below disagree instead of both being wrong in the same way.
 *
 *   function _scaleTokens(m, multiplyOnRemote, amount, isSendToRemote) {
 *     if (multiplyOnRemote == isSendToRemote) return amount * m;
 *     return amount / m;
 *   }
 */
const referenceScale = (
  m: bigint,
  multiplyOnRemote: boolean,
  amount: bigint,
  isSendToRemote: boolean,
): { ok: true; value: bigint } | { ok: false } => {
  if (multiplyOnRemote === isSendToRemote) {
    const product = amount * m;
    return product > MAX_UINT256 ? { ok: false } : { ok: true, value: product };
  }
  return m === 0n ? { ok: false } : { ok: true, value: amount / m };
};

const unwrap = (r: ReturnType<typeof applyTokenScale>): bigint => {
  if (!r.ok) throw new Error(`unexpected failure: ${r.reason}`);
  return r.value;
};

describe('deriveTokenMultiplierValues matches the contract', () => {
  it('multiplies on remote when the remote has more decimals', () => {
    const r = deriveTokenMultiplierValues(6n, 18n);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.multiplyOnRemote).toBe(true);
      expect(r.value.tokenMultiplier).toBe(10n ** 12n);
    }
  });

  it('divides on remote when the remote has fewer decimals', () => {
    const r = deriveTokenMultiplierValues(18n, 6n);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.multiplyOnRemote).toBe(false);
      expect(r.value.tokenMultiplier).toBe(10n ** 12n);
    }
  });

  it('is the identity when decimals match', () => {
    const r = deriveTokenMultiplierValues(18n, 18n);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.multiplyOnRemote).toBe(false);
      expect(r.value.tokenMultiplier).toBe(1n);
    }
  });

  it('refuses remote decimals above MAX_TOKEN_DECIMALS, as the home contract does', () => {
    expect(MAX_TOKEN_DECIMALS).toBe(SOURCE_FACTS.maxTokenDecimals);
    const r = deriveTokenMultiplierValues(6n, 19n);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('decimals-exceed-maximum');
  });

  it('refuses decimals outside the uint8 range', () => {
    expect(deriveTokenMultiplierValues(6n, -1n).ok).toBe(false);
    expect(deriveTokenMultiplierValues(256n, 6n).ok).toBe(false);
  });
});

describe('scaling direction, 6 <-> 18', () => {
  const m = 10n ** 12n;

  it('6 -> 18: one home unit becomes 1e12 remote units', () => {
    expect(unwrap(applyTokenScale(m, true, 1n))).toBe(10n ** 12n);
  });

  it('6 -> 18: the round trip is lossless for whole home units', () => {
    const home = 123_456_789n;
    const remote = unwrap(applyTokenScale(m, true, home));
    expect(unwrap(removeTokenScale(m, true, remote))).toBe(home);
  });

  it('6 -> 18: a sub-unit remote amount truncates to zero coming home', () => {
    // The remainder is not lost silently in the protocol: registration rounds
    // collateral up by one for exactly this case.
    expect(unwrap(removeTokenScale(m, true, 1n))).toBe(0n);
    expect(unwrap(removeTokenScale(m, true, m - 1n))).toBe(0n);
    expect(unwrap(removeTokenScale(m, true, m))).toBe(1n);
  });

  it('18 -> 6: sending to remote divides', () => {
    expect(unwrap(applyTokenScale(m, false, 10n ** 12n))).toBe(1n);
    expect(unwrap(applyTokenScale(m, false, m - 1n))).toBe(0n);
  });

  it('18 -> 6: coming home multiplies', () => {
    expect(unwrap(removeTokenScale(m, false, 1n))).toBe(10n ** 12n);
  });
});

describe('boundaries', () => {
  it('accepts a product that lands exactly on uint256 max', () => {
    expect(unwrap(applyTokenScale(1n, true, MAX_UINT256))).toBe(MAX_UINT256);
  });

  it('fails rather than wrapping when the product overflows uint256', () => {
    const r = applyTokenScale(2n, true, MAX_UINT256);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('overflow');
  });

  it('fails on division by a zero multiplier instead of returning a number', () => {
    const r = removeTokenScale(0n, true, 100n);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('division-by-zero');
  });

  it('multiplying by zero is allowed and yields zero, as on chain', () => {
    expect(unwrap(applyTokenScale(0n, true, 100n))).toBe(0n);
  });

  it('rejects negative inputs, which cannot exist in uint256', () => {
    expect(applyTokenScale(-1n, true, 1n).ok).toBe(false);
    expect(applyTokenScale(1n, true, -1n).ok).toBe(false);
  });

  it('handles the minimum non-zero amount in both directions', () => {
    const m = 10n ** 12n;
    expect(unwrap(applyTokenScale(m, true, 1n))).toBe(m);
    expect(unwrap(removeTokenScale(m, false, 1n))).toBe(m);
  });
});

describe('collateralNeeded rounds up exactly where the contract does', () => {
  const m = 10n ** 12n;

  it('adds one when multiplying on remote and the imbalance does not divide evenly', () => {
    expect(unwrap(deriveCollateralNeeded(m, true, 1n))).toBe(1n);
    expect(unwrap(deriveCollateralNeeded(m, true, m + 1n))).toBe(2n);
  });

  it('does not add one when the imbalance divides evenly', () => {
    expect(unwrap(deriveCollateralNeeded(m, true, m))).toBe(1n);
    expect(unwrap(deriveCollateralNeeded(m, true, 2n * m))).toBe(2n);
  });

  it('never adds one when multiplyOnRemote is false', () => {
    // removeTokenScale multiplies in this direction, so there is no remainder.
    expect(unwrap(deriveCollateralNeeded(m, false, 3n))).toBe(3n * m);
  });

  it('is zero only for a zero imbalance', () => {
    expect(unwrap(deriveCollateralNeeded(m, true, 0n))).toBe(0n);
  });

  it('always covers the imbalance: scaling the result back up never falls short', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        fc.integer({ min: 0, max: 18 }),
        (imbalance, exp) => {
          const mult = 10n ** BigInt(exp);
          const needed = deriveCollateralNeeded(mult, true, imbalance);
          expect(needed.ok).toBe(true);
          if (!needed.ok) return;
          // Converting the collateral back to remote units must not undershoot
          // the imbalance it is meant to cover.
          const backToRemote = applyTokenScale(mult, true, needed.value);
          expect(backToRemote.ok).toBe(true);
          if (backToRemote.ok) expect(backToRemote.value >= imbalance).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('differential against a reference written from the Solidity', () => {
  const arbMultiplier = fc.integer({ min: 0, max: 30 }).map((e) => 10n ** BigInt(e));
  const arbAmount = fc.bigInt({ min: 0n, max: 10n ** 40n });

  it('applyTokenScale agrees with the reference', () => {
    fc.assert(
      fc.property(arbMultiplier, fc.boolean(), arbAmount, (m, mor, amount) => {
        const mine = applyTokenScale(m, mor, amount);
        const ref = referenceScale(m, mor, amount, true);
        expect(mine.ok).toBe(ref.ok);
        if (mine.ok && ref.ok) expect(mine.value).toBe(ref.value);
      }),
      { numRuns: 1000 },
    );
  });

  it('removeTokenScale agrees with the reference', () => {
    fc.assert(
      fc.property(arbMultiplier, fc.boolean(), arbAmount, (m, mor, amount) => {
        const mine = removeTokenScale(m, mor, amount);
        const ref = referenceScale(m, mor, amount, false);
        expect(mine.ok).toBe(ref.ok);
        if (mine.ok && ref.ok) expect(mine.value).toBe(ref.value);
      }),
      { numRuns: 1000 },
    );
  });

  it('a home to remote round trip never invents value', () => {
    fc.assert(
      fc.property(
        arbMultiplier.filter((m) => m > 0n),
        fc.boolean(),
        arbAmount,
        (m, mor, home) => {
          const out = applyTokenScale(m, mor, home);
          if (!out.ok) return;
          const back = removeTokenScale(m, mor, out.value);
          expect(back.ok).toBe(true);
          // Division truncates, so the return trip may lose dust but must never gain.
          if (back.ok) expect(back.value <= home).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('the source facts this port depends on', () => {
  it('a canonical ERC20 remote is constructed with a zero reserve imbalance', () => {
    // Verified in the pinned source: __TokenRemote_init(settings, 0, decimals).
    // So no arbitrary initial-collateral term may be added for ERC20 routes.
    expect(SOURCE_FACTS.erc20RemoteInitialReserveImbalance).toBe(0n);
    expect(
      unwrap(
        deriveCollateralNeeded(10n ** 12n, true, SOURCE_FACTS.erc20RemoteInitialReserveImbalance),
      ),
    ).toBe(0n);
  });

  it('a native remote requires a non-zero reserve imbalance and 18 decimals', () => {
    expect(SOURCE_FACTS.nativeRemoteRequiresNonZeroReserve).toBe(true);
    expect(SOURCE_FACTS.nativeRemoteDecimals).toBe(18);
  });

  it('adding collateral never moves the transferred balance', () => {
    expect(SOURCE_FACTS.addCollateralTouchesTransferredBalance).toBe(false);
  });
});
