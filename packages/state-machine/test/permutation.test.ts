import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  AT,
  deliveredButFailed,
  doubleEffect,
  emptyPayload,
  envelopeResigned,
  failedThenRetried,
  happyPath,
  messageKey,
  permutations,
  receiptOnly,
  sendRetried,
} from '@ictt-sentinel/testkit';
import { reduce, reduceAll, emptyAggregate } from '../src/aggregate.js';
import { deriveState, type EvaluationContext } from '../src/derive.js';
import type { TransitionInput } from '../src/inputs.js';

/**
 * The properties the whole design exists to guarantee.
 *
 * State is derived from an unordered set, so order independence and idempotency
 * should hold by construction. These tests exist because "should hold by
 * construction" is a claim, and a claim about accounting deserves evidence.
 */

const CTX: EvaluationContext = { evaluatedAt: AT(600), staleAfterMs: 30 * 60 * 1000 };

const stateOf = (inputs: readonly TransitionInput[]) =>
  deriveState(reduceAll(inputs[0]?.message ?? messageKey(), inputs), CTX);

const SCENARIOS: readonly [string, readonly TransitionInput[]][] = [
  ['happy path', happyPath()],
  ['delivered but failed', deliveredButFailed()],
  ['failed then retried', failedThenRetried()],
  ['send retried', sendRetried()],
  ['envelope resigned', envelopeResigned()],
  ['empty payload', emptyPayload()],
  ['receipt only', receiptOnly()],
  ['double effect', doubleEffect()],
];

describe.each(SCENARIOS)('%s', (_name, facts) => {
  const expected = stateOf(facts);

  it('gives the same terminal state under every ingestion order', () => {
    // Exhaustive for the small fixtures, sampled for the larger ones.
    const orders = facts.length <= 6 ? permutations(facts) : shuffles(facts, 200);
    for (const order of orders) {
      const got = stateOf(order);
      expect(got.state).toBe(expected.state);
      expect(got.effect.count).toBe(expected.effect.count);
      expect(got.verdict).toBe(expected.verdict);
    }
  });

  it('is idempotent under re-application', () => {
    const once = stateOf(facts);
    const twice = stateOf([...facts, ...facts]);
    const thrice = stateOf([...facts, ...facts, ...facts]);
    expect(twice).toEqual(once);
    expect(thrice).toEqual(once);
  });

  it('references every raw fact it rests on', () => {
    const derived = stateOf(facts);
    const distinct = new Set(
      facts.map((f) => `${f.fact.blockHash}|${f.fact.txHash}|${String(f.fact.logIndex)}`),
    );
    expect(derived.supportingFacts).toHaveLength(distinct.size);
  });
});

/** Deterministic pseudo-shuffles, so a failure is reproducible. */
const shuffles = <T>(items: readonly T[], count: number): readonly (readonly T[])[] => {
  const out: T[][] = [];
  for (let seed = 1; seed <= count; seed += 1) {
    const copy = [...items];
    let s = seed;
    for (let i = copy.length - 1; i > 0; i -= 1) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const j = s % (i + 1);
      const a = copy[i];
      const b = copy[j];
      if (a !== undefined && b !== undefined) {
        copy[i] = b;
        copy[j] = a;
      }
    }
    out.push(copy);
  }
  return out;
};

describe('property: order and repetition never change the answer', () => {
  it('holds for arbitrary interleavings of a scenario with itself', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SCENARIOS.map(([, f]) => f)),
        fc.array(fc.nat({ max: 20 }), { minLength: 1, maxLength: 40 }),
        (facts, picks) => {
          // Build an arbitrary multiset of the scenario's facts, in an arbitrary
          // order, including repeats.
          const stream = picks
            .map((p) => facts[p % facts.length])
            .filter((f): f is TransitionInput => f !== undefined);
          const partial = stream.reduce(reduce, emptyAggregate(facts[0]?.message ?? messageKey()));
          const complete = facts.reduce(reduce, partial);
          // Whatever arrived first and however often, adding the full set gives
          // the canonical answer.
          expect(deriveState(complete, CTX)).toEqual(stateOf(facts));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never derives a second economic effect from a terminal success', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 10 }), { maxLength: 30 }), (picks) => {
        const facts = happyPath();
        const noise = picks
          .map((p) => facts[p % facts.length])
          .filter((f): f is TransitionInput => f !== undefined);
        const derived = stateOf([...facts, ...noise]);
        expect(derived.state).toBe('EXECUTED_SUCCESS');
        // Re-observing the same success can never credit it twice.
        expect(derived.effect.count).toBe(1);
        expect(derived.duplicateEffectFacts).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});
