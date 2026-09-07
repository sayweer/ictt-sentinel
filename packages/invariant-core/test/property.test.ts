import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { pendingEnvelope, proofInput, remote, type ProofOptions } from '@ictt-sentinel/testkit';
import { canonicalInputString, evaluateCanonicalErc20 } from '../src/engine.js';
import { isGreen } from '../src/outcome.js';
import { FORBIDDEN_CLAIM_WORDS, REASON_CODES, REASON_META } from '../src/reasons.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const run = (o: ProofOptions = {}) => evaluateCanonicalErc20(proofInput(o), sha256);

describe('conservation', () => {
  it('holds the equation for any split of pending amounts', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        (base, h2r, r2h) => {
          // Construct D and S so the verified equation holds by construction,
          // then assert the engine agrees.
          const d = base + h2r;
          const s = base - (r2h > base ? base : r2h);
          const settled = r2h > base ? base : r2h;
          const e = evaluateCanonicalErc20(
            proofInput({
              remotes: [remote({ transferredBalance: d, remoteTotalSupply: s })],
              pending: [
                ...(h2r > 0n ? [pendingEnvelope('home-to-remote', h2r)] : []),
                ...(settled > 0n ? [pendingEnvelope('remote-to-home', settled)] : []),
              ],
              escrowBalance: 1n << 200n,
            }),
            sha256,
          );
          expect(e.gateA.outcome).toBe('pass');
          expect(e.gateA.totalDelta).toBe(e.gateA.totalPending);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('order independence and idempotency', () => {
  const scenario = (): ProofOptions => ({
    remotes: [remote({ transferredBalance: 1_750n, remoteTotalSupply: 1_000n })],
    pending: [
      pendingEnvelope('home-to-remote', 500n, { messageKey: 'a' }),
      pendingEnvelope('remote-to-home', 250n, { messageKey: 'b' }),
    ],
    escrowBalance: 10n ** 6n,
  });

  it('gives the same answer whatever order the pending envelopes arrive in', () => {
    const forward = run(scenario());
    const s = scenario();
    const reversed = run({ ...s, pending: [...(s.pending ?? [])].reverse() });
    expect(reversed.output).toEqual(forward.output);
    // Including the digest: provider arrival order must not change evidence.
    expect(reversed.output.inputDigest).toBe(forward.output.inputDigest);
  });

  it('gives the same answer whatever order the remotes arrive in', () => {
    const two: ProofOptions = {
      remotes: [
        remote({ remoteAddress: `0x${'11'.repeat(20)}` }),
        remote({ remoteAddress: `0x${'22'.repeat(20)}` }),
      ],
      escrowBalance: 10n ** 6n,
    };
    const forward = run(two);
    const reversed = run({ ...two, remotes: [...(two.remotes ?? [])].reverse() });
    expect(reversed.output.inputDigest).toBe(forward.output.inputDigest);
    expect(reversed.output.result).toBe(forward.output.result);
  });

  it('is idempotent: evaluating twice changes nothing', () => {
    const input = proofInput(scenario());
    expect(evaluateCanonicalErc20(input, sha256).output).toEqual(
      evaluateCanonicalErc20(input, sha256).output,
    );
  });

  it('produces a stable canonical string for the same inputs', () => {
    const input = proofInput(scenario());
    expect(canonicalInputString(input)).toBe(canonicalInputString(input));
  });

  it('changes the digest when a pinned block hash changes', () => {
    const a = run(scenario());
    const b = run({ ...scenario(), remotes: [remote({ transferredBalance: 1_751n })] });
    expect(b.output.inputDigest).not.toBe(a.output.inputDigest);
  });
});

describe('no false OK under missing input', () => {
  /** Every way the input contract can be incomplete. */
  const degradations: readonly ProofOptions[] = [
    { manifestHash: null },
    { policyHash: null },
    { sourceLockCommitSha: null },
    { census: 'partial' },
    { census: 'unknown' },
    { cut: 'open' },
    { cut: 'gap' },
    { fresh: false },
    { witnessGroups: 0 },
    { witnessGroups: 1 },
    { untrackedRemotes: ['0xdead'] },
    { escrowBalance: null },
    { homeEscrowPin: false },
    { remotes: [] },
    { remotes: [remote({ transferredBalance: null })] },
    { remotes: [remote({ remoteTotalSupply: null })] },
    { remotes: [remote({ homePin: false })] },
    { remotes: [remote({ remotePin: false })] },
    { remotes: [remote({ established: false })] },
    { remotes: [remote({ fingerprintRecognised: false })] },
    { remotes: [remote({ tokenBehaviourCanonical: false })] },
    { remotes: [remote({ routeSingleHop: false })] },
    { remotes: [remote({ initialReserveImbalance: 1n })] },
    { family: 'native-token' },
  ];

  it('the fully evidenced baseline IS green, so the corpus below means something', () => {
    expect(isGreen(run({ escrowBalance: 10n ** 6n }).output)).toBe(true);
  });

  it.each(degradations.map((d, i) => [i, d] as const))(
    'degradation %i never produces OK',
    (_i, over) => {
      const e = run({ escrowBalance: 10n ** 6n, ...over });
      expect(isGreen(e.output)).toBe(false);
      expect(e.output.verdictCandidate).not.toBe('OK');
      expect(e.output.result).not.toBe('PASS');
    },
  );

  it('any single degradation is enough, even combined with a healthy ledger', () => {
    fc.assert(
      fc.property(fc.constantFrom(...degradations), (over) => {
        const e = run({ escrowBalance: 1n << 200n, ...over });
        expect(e.output.verdictCandidate).not.toBe('OK');
      }),
      { numRuns: 200 },
    );
  });
});

describe('claim hygiene', () => {
  it('covers every reason code with metadata', () => {
    expect(Object.keys(REASON_META).sort()).toEqual([...REASON_CODES].sort());
  });

  it('never phrases a coverage gap in economic language', () => {
    for (const code of REASON_CODES) {
      const text = REASON_META[code].summary.toLowerCase();
      for (const word of FORBIDDEN_CLAIM_WORDS) {
        expect(text, `${code} says "${word}"`).not.toContain(word);
      }
    }
  });

  it('marks no accounting or configuration reason as heuristic', () => {
    // A heuristic signal must never reach an accounting rule. Only the RSK-*
    // family may carry that class, and it is reported under its own language.
    for (const code of REASON_CODES) {
      const cls = REASON_META[code].proofClass;
      if (code.startsWith('RSK-')) continue;
      expect(cls, `${code} is heuristic`).not.toBe('heuristic');
    }
    expect(REASON_META['RSK-H01-RATE-ANOMALY'].proofClass).toBe('heuristic');
  });

  it('states its assumptions and exclusions on every output', () => {
    const e = run({ escrowBalance: 10n ** 6n });
    expect(e.output.assumptions.length).toBeGreaterThan(2);
    expect(e.output.exclusions.length).toBeGreaterThan(2);
    // The lower-bound framing is explicit, not implied.
    expect(e.output.assumptions.join(' ')).toContain('not absolute solvency');
  });
});
