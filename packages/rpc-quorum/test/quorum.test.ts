import { describe, expect, it } from 'vitest';
import {
  assertNoIntegrityConflict,
  evaluateQuorum,
  type ExpectedIdentity,
  type QuorumPolicy,
  type WitnessObservation,
} from '../src/quorum.js';
import { RpcIntegrityConflict } from '../src/errors.js';
import {
  buildPinnedContext,
  decideFinalityBasis,
  finalityFromConfirmationDepth,
  guardRead,
  isExpired,
  reconstructBlockHashLocally,
  type EndpointCapability,
} from '../src/pinned.js';
import {
  ASSURANCE_MODE,
  FORBIDDEN_ASSURANCE_CLAIMS,
  GATE_B_CAPABILITIES,
  evaluateGateA,
  gateBStatus,
  requireGateB,
} from '../src/gates.js';

const b32 = (s: string): string => `0x${s.repeat(64).slice(0, 64)}`;
const CHAIN = b32('1');
const HASH_A = b32('a');
const HASH_B = b32('b');
const NOW = 1_000_000;

const expected: ExpectedIdentity = { blockchainId: CHAIN, evmChainId: 43114n, networkId: 1n };
const policy: QuorumPolicy = {
  minIndependentTrustDomains: 2,
  maxHeadLagBlocks: 5n,
  maxObservationAgeMs: 60_000,
};

const witness = (over: Partial<WitnessObservation> = {}): WitnessObservation => ({
  endpointId: 'e1',
  trustDomain: over.trustDomain ?? 'provider-alpha',
  providerGroup: over.providerGroup ?? `${over.trustDomain ?? 'provider-alpha'}-prod`,
  blockchainId: CHAIN,
  evmChainId: 43114n,
  networkId: 1n,
  headBlockNumber: 1000n,
  hashAtHeight: HASH_A,
  observedAtMs: NOW,
  archiveDepth: 'unknown',
  ...over,
});

describe('quorum counts witnesses independent by provider group and trust domain', () => {
  it('agrees when two independent providers report the same hash', () => {
    const r = evaluateQuorum(
      [
        witness(),
        witness({ endpointId: 'e2', trustDomain: 'provider-beta', providerGroup: 'beta-prod' }),
      ],
      expected,
      policy,
      NOW,
    );
    expect(r.outcome).toBe('agreed');
    expect(r.agreeingTrustDomains).toEqual(['provider-alpha', 'provider-beta']);
    expect(r.agreeingProviderGroups).toEqual(['beta-prod', 'provider-alpha-prod']);
    expect(r.blockHash).toBe(HASH_A);
  });

  it('refuses a single endpoint under a policy requiring two domains', () => {
    const r = evaluateQuorum([witness()], expected, policy, NOW);
    expect(r.outcome).toBe('insufficient-witnesses');
    expect(r.reasons.join(' ')).toContain('provider group and trust domain');
  });

  it('counts three URLs from one provider as one witness', () => {
    const r = evaluateQuorum(
      [witness({ endpointId: 'e1' }), witness({ endpointId: 'e2' }), witness({ endpointId: 'e3' })],
      expected,
      policy,
      NOW,
    );
    expect(r.outcome).toBe('insufficient-witnesses');
    expect(r.agreeingTrustDomains).toEqual(['provider-alpha']);
    expect(r.reasons.join(' ')).toContain('count as one witness');
  });

  it('counts distinct provider groups inside one trust domain as one witness', () => {
    const r = evaluateQuorum(
      [
        witness({ endpointId: 'e1', providerGroup: 'alpha-eu' }),
        witness({ endpointId: 'e2', providerGroup: 'alpha-us' }),
      ],
      expected,
      policy,
      NOW,
    );
    expect(r.outcome).toBe('insufficient-witnesses');
    expect(r.agreeingTrustDomains).toEqual(['provider-alpha']);
  });

  it('counts distinct trust domains inside one provider group as one witness', () => {
    const r = evaluateQuorum(
      [
        witness({
          endpointId: 'e1',
          trustDomain: 'account-a',
          providerGroup: 'provider-alpha-prod',
        }),
        witness({
          endpointId: 'e2',
          trustDomain: 'account-b',
          providerGroup: 'provider-alpha-prod',
        }),
      ],
      expected,
      policy,
      NOW,
    );
    expect(r.outcome).toBe('insufficient-witnesses');
    expect(r.agreeingProviderGroups).toEqual(['provider-alpha-prod']);
  });
});

describe('same height, different hash is never resolved by choosing one', () => {
  it('reports disagreement instead of a majority', () => {
    const r = evaluateQuorum(
      [
        witness({ endpointId: 'e1', trustDomain: 'a', hashAtHeight: HASH_A }),
        witness({ endpointId: 'e2', trustDomain: 'b', hashAtHeight: HASH_A }),
        witness({ endpointId: 'e3', trustDomain: 'c', hashAtHeight: HASH_B }),
      ],
      expected,
      policy,
      NOW,
    );
    expect(r.outcome).toBe('disagreement');
    expect(r.blockHash).toBeUndefined();
    expect(r.agreeingTrustDomains).toEqual([]);
    expect(r.reasons.join(' ')).toContain('would invent agreement');
  });
});

describe('endpoints serving the wrong chain are separated out', () => {
  it.each([
    ['blockchainId', { blockchainId: b32('9') }, 'wrong-blockchain-id'],
    ['evm chain id', { evmChainId: 1n }, 'wrong-evm-chain-id'],
    ['network id', { networkId: 5n }, 'wrong-network-id'],
  ])('rejects a witness with the wrong %s', (_l, over, reason) => {
    const r = evaluateQuorum(
      [witness(), witness({ endpointId: 'e2', trustDomain: 'provider-beta', ...over })],
      expected,
      policy,
      NOW,
    );
    expect(r.rejected.map((x) => x.reason)).toContain(reason);
    expect(r.outcome).toBe('insufficient-witnesses');
  });

  it('rejects a witness that never established an identity', () => {
    const r = evaluateQuorum(
      [witness(), witness({ endpointId: 'e2', trustDomain: 'b', blockchainId: undefined })],
      expected,
      policy,
      NOW,
    );
    expect(r.rejected.map((x) => x.reason)).toContain('missing-identity');
  });

  it('never accepts an EVM chain id in place of the Avalanche blockchainID', () => {
    // The two are different fields with different values; a witness supplying
    // the chain id as the blockchain identity is simply wrong.
    const r = evaluateQuorum([witness({ blockchainId: '0xa86a' })], expected, policy, NOW);
    expect(r.rejected[0]?.reason).toBe('wrong-blockchain-id');
  });
});

describe('staleness and head lag', () => {
  it('rejects an observation older than the freshness policy', () => {
    const r = evaluateQuorum(
      [witness(), witness({ endpointId: 'e2', trustDomain: 'b', observedAtMs: NOW - 120_000 })],
      expected,
      policy,
      NOW,
    );
    expect(r.rejected.map((x) => x.reason)).toContain('stale-observation');
  });

  it('rejects a witness lagging beyond the policy and records the degradation', () => {
    const r = evaluateQuorum(
      [
        witness({ endpointId: 'e1', trustDomain: 'a', headBlockNumber: 1000n }),
        witness({ endpointId: 'e2', trustDomain: 'b', headBlockNumber: 1000n }),
        witness({ endpointId: 'e3', trustDomain: 'c', headBlockNumber: 900n }),
      ],
      expected,
      policy,
      NOW,
    );
    expect(r.rejected.map((x) => x.reason)).toContain('head-lagging');
    expect(r.degraded.join(' ')).toContain('head lagging');
    expect(r.outcome).toBe('agreed');
  });

  it('agrees at the lowest common height so no witness is asked about a block it lacks', () => {
    const r = evaluateQuorum(
      [
        witness({ endpointId: 'e1', trustDomain: 'a', headBlockNumber: 1003n }),
        witness({ endpointId: 'e2', trustDomain: 'b', headBlockNumber: 1000n }),
      ],
      expected,
      policy,
      NOW,
    );
    expect(r.outcome).toBe('agreed');
    expect(r.height).toBe(1000n);
  });

  it('records a witness that could not supply a hash at the common height', () => {
    const r = evaluateQuorum(
      [
        witness({ endpointId: 'e1', trustDomain: 'a' }),
        witness({ endpointId: 'e2', trustDomain: 'b' }),
        witness({ endpointId: 'e3', trustDomain: 'c', hashAtHeight: undefined }),
      ],
      expected,
      policy,
      NOW,
    );
    expect(r.rejected.map((x) => x.reason)).toContain('no-hash-at-height');
    expect(r.degraded.join(' ')).toContain('no hash at the common height');
  });
});

describe('a hash change at an already accepted height is an integrity conflict', () => {
  it('throws rather than rolling back as a reorg', () => {
    // Avalanche acceptance is final, so this cannot be a reorg. Treating it as
    // one would quietly discard evidence of something much worse.
    expect(() => {
      assertNoIntegrityConflict(
        { blockNumber: 1000n, blockHash: HASH_A },
        { blockNumber: 1000n, blockHash: HASH_B, endpointId: 'e2', trustDomain: 'b' },
      );
    }).toThrow(RpcIntegrityConflict);
  });

  it('names the code and refuses the reorg framing', () => {
    try {
      assertNoIntegrityConflict(
        { blockNumber: 1000n, blockHash: HASH_A },
        { blockNumber: 1000n, blockHash: HASH_B, endpointId: 'e2', trustDomain: 'b' },
      );
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcIntegrityConflict);
      const c = e as RpcIntegrityConflict;
      expect(c.code).toBe('RPC_INTEGRITY_CONFLICT');
      expect(c.recordedHash).toBe(HASH_A);
      expect(c.observedHash).toBe(HASH_B);
      expect(c.message).toContain('not a reorg');
    }
  });

  it('passes when the hash matches, ignoring case', () => {
    expect(() => {
      assertNoIntegrityConflict(
        { blockNumber: 1000n, blockHash: HASH_A.toUpperCase() },
        { blockNumber: 1000n, blockHash: HASH_A, endpointId: 'e1', trustDomain: 'a' },
      );
    }).not.toThrow();
  });

  it('says nothing about a height that was never recorded', () => {
    expect(() => {
      assertNoIntegrityConflict(undefined, {
        blockNumber: 1000n,
        blockHash: HASH_B,
        endpointId: 'e1',
        trustDomain: 'a',
      });
    }).not.toThrow();
  });
});

describe('finality capability is probed, never assumed', () => {
  const cap = (over: Partial<EndpointCapability> = {}): EndpointCapability => ({
    endpointId: 'e1',
    trustDomain: 'a',
    probes: [],
    acceptedStateEvidence: 'unproven',
    archiveDepth: 'unknown',
    ...over,
  });

  it('uses latest when the endpoint was shown to answer from accepted state', () => {
    const d = decideFinalityBasis(cap({ acceptedStateEvidence: 'probed-accepted-only' }));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.basis).toBe('accepted-latest');
  });

  it('uses a finality tag only when the probe proved it', () => {
    const d = decideFinalityBasis(
      cap({
        acceptedStateEvidence: 'probed-finality-tag',
        probes: [{ tag: 'finalized', supported: true, height: 100n, detail: 'resolved' }],
      }),
    );
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.basis).toBe('finalized-tag');
  });

  it('does not fall back to latest when finalized is unsupported and nothing was proven', () => {
    const d = decideFinalityBasis(
      cap({ probes: [{ tag: 'finalized', supported: false, detail: 'unknown block tag' }] }),
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain('would assert a guarantee that was not shown');
  });

  it('refuses to derive finality from a confirmation count', () => {
    expect(() => finalityFromConfirmationDepth(12)).toThrow(/acceptance is final/);
    expect(() => finalityFromConfirmationDepth(1000)).toThrow();
  });

  it('refuses to reconstruct a C-Chain block hash locally', () => {
    expect(() => reconstructBlockHashLocally()).toThrow(
      /never reconstructed from geth header fields/,
    );
  });
});

describe('pinned context', () => {
  const agreed = evaluateQuorum(
    [witness(), witness({ endpointId: 'e2', trustDomain: 'provider-beta' })],
    expected,
    policy,
    NOW,
  );

  it('is built from agreement plus established finality', () => {
    const r = buildPinnedContext({
      quorum: agreed,
      identity: expected,
      capability: { ok: true, basis: 'accepted-latest', evidence: 'probed-accepted-only' },
      observedAtMs: NOW,
      freshnessMs: 300_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.context.blockNumber).toBe(1000n);
      expect(r.context.blockHash).toBe(HASH_A);
      expect(r.context.agreeingTrustDomains).toHaveLength(2);
      expect(r.context.expiresAtMs).toBe(NOW + 300_000);
    }
  });

  it('is refused when the quorum did not agree', () => {
    const disagreed = evaluateQuorum(
      [
        witness({ endpointId: 'e1', trustDomain: 'a', hashAtHeight: HASH_A }),
        witness({ endpointId: 'e2', trustDomain: 'b', hashAtHeight: HASH_B }),
      ],
      expected,
      policy,
      NOW,
    );
    const r = buildPinnedContext({
      quorum: disagreed,
      identity: expected,
      capability: { ok: true, basis: 'accepted-latest', evidence: 'probed-accepted-only' },
      observedAtMs: NOW,
      freshnessMs: 300_000,
    });
    expect(r.ok).toBe(false);
  });

  it('is refused when finality was not established', () => {
    const r = buildPinnedContext({
      quorum: agreed,
      identity: expected,
      capability: { ok: false, reason: 'nothing proven' },
      observedAtMs: NOW,
      freshnessMs: 300_000,
    });
    expect(r.ok).toBe(false);
  });

  it('expires', () => {
    const r = buildPinnedContext({
      quorum: agreed,
      identity: expected,
      capability: { ok: true, basis: 'accepted-latest', evidence: 'probed-accepted-only' },
      observedAtMs: NOW,
      freshnessMs: 1_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(isExpired(r.context, NOW + 500)).toBe(false);
      expect(isExpired(r.context, NOW + 1_500)).toBe(true);
    }
  });
});

describe('hash-before / read / hash-after', () => {
  it('accepts a read when the hash held', () => {
    expect(guardRead(HASH_A, 'value', HASH_A)).toEqual({ ok: true, value: 'value' });
  });

  it('discards a read when the hash changed underneath it', () => {
    const g = guardRead(HASH_A, 'value', HASH_B);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe('hash-changed-during-read');
  });

  it('ignores case when comparing hashes', () => {
    expect(guardRead(HASH_A.toUpperCase(), 1, HASH_A).ok).toBe(true);
  });
});

describe('Gate A is required and Gate B is a declared non-goal', () => {
  const fullPass = {
    chainIdentityVerified: true,
    acceptedStateEstablished: true,
    quorumAgreed: true,
    independentTrustDomains: 2,
    requiredTrustDomains: 2,
    pinnedContextBuilt: true,
    freshWithinPolicy: true,
  };

  it('passes when every condition holds', () => {
    expect(evaluateGateA(fullPass)).toEqual({ passed: true, missing: [] });
  });

  it.each([
    ['identity', { chainIdentityVerified: false }],
    ['accepted state', { acceptedStateEstablished: false }],
    ['quorum', { quorumAgreed: false }],
    ['independence', { independentTrustDomains: 1 }],
    ['pinned context', { pinnedContextBuilt: false }],
    ['freshness', { freshWithinPolicy: false }],
  ])('fails when %s is missing', (_l, over) => {
    const r = evaluateGateA({ ...fullPass, ...over });
    expect(r.passed).toBe(false);
    expect(r.missing.length).toBeGreaterThan(0);
  });

  it('declares the assurance mode chosen in ADR-0004', () => {
    expect(ASSURANCE_MODE).toBe('ACCEPTED_STATE_ASSURANCE');
  });

  it('reports Gate B as out of scope, listing what is not implemented', () => {
    const s = gateBStatus();
    expect(s.inScope).toBe(false);
    expect(s.unimplemented).toEqual(GATE_B_CAPABILITIES);
    expect(s.claim).toContain('does not');
    expect(s.claim).toContain('BLS');
  });

  it('throws if any Gate B capability is invoked', () => {
    for (const c of GATE_B_CAPABILITIES) {
      expect(() => requireGateB(c), c).toThrow(/out of scope/);
    }
  });

  it('the declared claim contains no forbidden assurance phrase', () => {
    const claim = gateBStatus().claim.toLowerCase();
    for (const phrase of FORBIDDEN_ASSURANCE_CLAIMS) {
      // "does not independently verify" is the negation, so match the bare claim.
      const asPositive = claim.includes(phrase) && !claim.includes(`not ${phrase}`);
      expect(asPositive, phrase).toBe(false);
    }
  });
});
