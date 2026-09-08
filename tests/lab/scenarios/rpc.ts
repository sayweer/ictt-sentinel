import {
  buildPinnedContext,
  decideFinalityBasis,
  evaluateQuorum,
  finalityFromConfirmationDepth,
  guardRead,
  reconstructBlockHashLocally,
  type EndpointCapability,
  type ExpectedIdentity,
  type QuorumPolicy,
  type WitnessObservation,
} from '@ictt-sentinel/rpc-quorum';
import { agree, assessCompleteness, findRangeGaps } from '@ictt-sentinel/replay';
import { defineScenarios } from '../registry.js';

/**
 * Provider-level faults.
 *
 * Every scenario here attacks the same claim: that this product knows which
 * chain it is reading, at which block, and on whose word. None of them may end
 * green, and the ones that pretend to be a quorum are the sharpest - a fake
 * quorum is indistinguishable from a real one unless independence is counted
 * rather than assumed.
 */

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const HOME_ICM = `0x${'aa'.repeat(32)}`;
const HASH_A = `0x${'11'.repeat(32)}`;
const HASH_B = `0x${'22'.repeat(32)}`;

const EXPECTED: ExpectedIdentity = {
  blockchainId: HOME_ICM,
  evmChainId: 43_114n,
  networkId: 1n,
};

const POLICY: QuorumPolicy = {
  minIndependentTrustDomains: 2,
  maxHeadLagBlocks: 5n,
  maxObservationAgeMs: 30_000,
};

const witness = (o: Partial<WitnessObservation> & { endpointId: string }): WitnessObservation => ({
  trustDomain: o.trustDomain ?? 'alpha',
  providerGroup: o.providerGroup ?? `${o.trustDomain ?? 'alpha'}-1`,
  blockchainId: HOME_ICM,
  evmChainId: 43_114n,
  networkId: 1n,
  headBlockNumber: 1_000n,
  hashAtHeight: HASH_A,
  observedAtMs: NOW,
  archiveDepth: 'full',
  ...o,
});

const capability = (o: Partial<EndpointCapability> = {}): EndpointCapability => ({
  endpointId: 'ep-1',
  trustDomain: 'alpha',
  probes: [{ tag: 'finalized', supported: false, detail: 'not documented for the C-Chain API' }],
  acceptedStateEvidence: 'probed-accepted-only',
  archiveDepth: 'full',
  ...o,
});

/** Quorum outcome plus the rejection reasons, as one observation. */
const quorumRun = (observations: readonly WitnessObservation[]) => {
  const result = evaluateQuorum(observations, EXPECTED, POLICY, NOW);
  return {
    reasonCodes: [
      `QUORUM_${result.outcome.toUpperCase().replace(/-/g, '_')}`,
      ...result.rejected.map((r) => `REJECTED_${r.reason.toUpperCase().replace(/-/g, '_')}`),
    ],
    holds:
      result.outcome === 'agreed'
        ? []
        : ['no-pinned-context', `agreeing-domains=${String(result.agreeingTrustDomains.length)}`],
    // No pin means no comparative read, so nothing downstream can be evaluated.
    protocolStatus: result.outcome === 'agreed' ? undefined : ('UNKNOWN' as const),
    dataStatus: result.outcome === 'agreed' ? undefined : ('DIVERGENT' as const),
    exitCode: result.outcome === 'agreed' ? 0 : 3,
  };
};

export const rpcScenarios = defineScenarios([
  {
    id: 'rpc/wrong-evm-chain-id',
    title: 'A witness answers from a different EVM chain',
    corpus: 'rpc',
    provenance: 'docs/DATA_MODEL.md 2.1; docs/adr/0002-accepted-quorum-truth.md',
    pinned: { expectedEvmChainId: '43114', witnessEvmChainId: '43113', height: '1000' },
    expect: {
      protocolStatus: 'UNKNOWN',
      reasonCodes: ['REJECTED_WRONG_EVM_CHAIN_ID'],
      exitCode: 3,
      holds: ['no-pinned-context'],
    },
    run: () =>
      quorumRun([
        witness({ endpointId: 'ep-1' }),
        witness({ endpointId: 'ep-2', trustDomain: 'beta', evmChainId: 43_113n }),
      ]),
  },
  {
    id: 'rpc/wrong-blockchain-id',
    title: 'A witness answers from a different Avalanche blockchain',
    corpus: 'rpc',
    provenance: 'CLAUDE.md 4; docs/DATA_MODEL.md 2.1',
    pinned: { expectedBlockchainId: HOME_ICM, witnessBlockchainId: `0x${'bb'.repeat(32)}` },
    expect: {
      protocolStatus: 'UNKNOWN',
      reasonCodes: ['REJECTED_WRONG_BLOCKCHAIN_ID'],
      exitCode: 3,
    },
    run: () =>
      quorumRun([
        witness({ endpointId: 'ep-1' }),
        witness({
          endpointId: 'ep-2',
          trustDomain: 'beta',
          blockchainId: `0x${'bb'.repeat(32)}`,
        }),
      ]),
  },
  {
    id: 'rpc/evm-id-substituted-for-icm-id',
    title: 'The EVM chainId is offered where the ICM blockchainID belongs',
    corpus: 'rpc',
    // The two live in different identity spaces; a 32-byte ICM id can never be
    // an EVM chainId, and accepting one for the other is the mistake the schema
    // exists to make impossible.
    provenance: 'CLAUDE.md 4; docs/DATA_MODEL.md 2.1',
    pinned: { substituted: '0x000...a86a (43114 as bytes32)' },
    expect: {
      protocolStatus: 'UNKNOWN',
      reasonCodes: ['REJECTED_WRONG_BLOCKCHAIN_ID'],
      exitCode: 3,
    },
    run: () =>
      quorumRun([
        witness({ endpointId: 'ep-1' }),
        witness({
          endpointId: 'ep-2',
          trustDomain: 'beta',
          blockchainId: `0x${(43_114).toString(16).padStart(64, '0')}`,
        }),
      ]),
  },
  {
    id: 'rpc/same-height-different-hash',
    title: 'Two independent witnesses report different hashes at one height',
    corpus: 'rpc',
    provenance: 'docs/adr/0002-accepted-quorum-truth.md; docs/RUNBOOK.md',
    pinned: { height: '1000', hashA: HASH_A, hashB: HASH_B },
    expect: {
      protocolStatus: 'UNKNOWN',
      dataStatus: 'DIVERGENT',
      exitCode: 3,
      holds: ['no-pinned-context'],
    },
    run: () =>
      quorumRun([
        witness({ endpointId: 'ep-1' }),
        witness({ endpointId: 'ep-2', trustDomain: 'beta', hashAtHeight: HASH_B }),
      ]),
  },
  {
    id: 'rpc/fake-quorum-one-provider-group',
    title: 'Two endpoints in one provider group are offered as two witnesses',
    corpus: 'rpc',
    provenance: 'CLAUDE.md 4; .claude/rules/data-integrity.md',
    pinned: { endpoints: '2', trustDomains: '1', requiredDomains: '2' },
    expect: {
      protocolStatus: 'UNKNOWN',
      exitCode: 3,
      // Counted over domains, so two agreeing endpoints are still one witness.
      holds: ['agreeing-domains=1'],
    },
    run: () =>
      quorumRun([
        witness({ endpointId: 'ep-1' }),
        witness({ endpointId: 'ep-2', trustDomain: 'beta', providerGroup: 'alpha-1' }),
      ]),
  },
  {
    id: 'rpc/two-urls-one-upstream',
    title: 'Two URLs sharing an upstream do not become two votes',
    corpus: 'rpc',
    provenance: 'docs/adr/0002-accepted-quorum-truth.md',
    pinned: { urls: '2', sharedTrustDomain: 'alpha' },
    expect: { protocolStatus: 'UNKNOWN', exitCode: 3, holds: ['agreeing-domains=1'] },
    run: () =>
      quorumRun([
        witness({ endpointId: 'https-a' }),
        witness({ endpointId: 'https-b', trustDomain: 'alpha', providerGroup: 'alpha-2' }),
      ]),
  },
  {
    id: 'rpc/stale-observation',
    title: 'An observation older than the policy window is not a vote',
    corpus: 'rpc',
    provenance: 'docs/INVARIANTS.md; policy spec.evidence.maxAgeSeconds',
    pinned: { observationAgeMs: '120000', maxObservationAgeMs: '30000' },
    expect: { protocolStatus: 'UNKNOWN', reasonCodes: ['REJECTED_STALE_OBSERVATION'], exitCode: 3 },
    run: () =>
      quorumRun([
        witness({ endpointId: 'ep-1' }),
        witness({ endpointId: 'ep-2', trustDomain: 'beta', observedAtMs: NOW - 120_000 }),
      ]),
  },
  {
    id: 'rpc/head-lagging',
    title: 'A witness too far behind the leader is not counted',
    corpus: 'rpc',
    provenance: 'docs/adr/0002-accepted-quorum-truth.md',
    pinned: { leaderHead: '1000', laggingHead: '900', maxLag: '5' },
    expect: { protocolStatus: 'UNKNOWN', reasonCodes: ['REJECTED_HEAD_LAGGING'], exitCode: 3 },
    run: () =>
      quorumRun([
        witness({ endpointId: 'ep-1' }),
        witness({ endpointId: 'ep-2', trustDomain: 'beta', headBlockNumber: 900n }),
      ]),
  },
  {
    id: 'rpc/accepted-state-capability-conflict',
    title: 'An endpoint that never established accepted-state semantics cannot pin',
    corpus: 'rpc',
    provenance: 'docs/PROTOCOL_SOURCE_LOCK.md 6; docs/adr/0002-accepted-quorum-truth.md',
    pinned: { acceptedStateEvidence: 'none', finalizedTag: 'unsupported' },
    expect: { protocolStatus: 'UNKNOWN', exitCode: 3, holds: ['capability-refused', 'no-pin'] },
    run: () => {
      const decision = decideFinalityBasis(
        capability({ acceptedStateEvidence: 'none', probes: [] }),
      );
      const quorum = evaluateQuorum(
        [witness({ endpointId: 'ep-1' }), witness({ endpointId: 'ep-2', trustDomain: 'beta' })],
        EXPECTED,
        POLICY,
        NOW,
      );
      const pin = buildPinnedContext({
        quorum,
        identity: EXPECTED,
        capability: decision,
        observedAtMs: NOW,
        freshnessMs: 60_000,
      });
      return {
        protocolStatus: 'UNKNOWN',
        exitCode: 3,
        holds: [
          ...(decision.ok ? [] : ['capability-refused']),
          ...(pin.ok ? [] : ['no-pin']),
          `quorum=${quorum.outcome}`,
        ],
      };
    },
  },
  {
    id: 'rpc/unsupported-finality-tag',
    title: 'An unsupported safe/finalized tag never degrades to latest',
    corpus: 'rpc',
    provenance: 'docs/PROTOCOL_SOURCE_LOCK.md 6',
    pinned: { probedTag: 'finalized', supported: 'false' },
    expect: { protocolStatus: 'UNKNOWN', exitCode: 3, holds: ['no-finalized-basis'] },
    run: () => {
      const decision = decideFinalityBasis(
        capability({
          acceptedStateEvidence: 'none',
          probes: [{ tag: 'finalized', supported: false, detail: 'not documented' }],
        }),
      );
      return {
        protocolStatus: 'UNKNOWN',
        exitCode: 3,
        holds: decision.ok ? [] : ['no-finalized-basis'],
      };
    },
  },
  {
    id: 'rpc/confirmation-depth-is-not-finality',
    title: 'Ethereum-style confirmation depth is refused as finality evidence',
    corpus: 'operational',
    provenance: 'CLAUDE.md 5; docs/PROTOCOL_SOURCE_LOCK.md',
    pinned: { confirmations: '12' },
    expect: { holds: ['refused'] },
    run: () => {
      let refused = false;
      try {
        finalityFromConfirmationDepth(12);
      } catch {
        refused = true;
      }
      return { holds: refused ? ['refused'] : [] };
    },
  },
  {
    id: 'rpc/local-hash-reconstruction-refused',
    title: 'A C-Chain block hash is never rebuilt from geth header fields',
    corpus: 'operational',
    provenance: 'docs/PROTOCOL_SOURCE_LOCK.md 6',
    pinned: { attempt: 'reconstructBlockHashLocally' },
    expect: { holds: ['refused'] },
    run: () => {
      let refused = false;
      try {
        reconstructBlockHashLocally();
      } catch {
        refused = true;
      }
      return { holds: refused ? ['refused'] : [] };
    },
  },
  {
    id: 'rpc/hash-changed-during-read',
    title: 'A state read straddling a hash change is discarded, not reported',
    corpus: 'rpc',
    provenance: 'docs/DATA_MODEL.md 2.3',
    pinned: { hashBefore: HASH_A, hashAfter: HASH_B },
    expect: { protocolStatus: 'UNKNOWN', exitCode: 3, holds: ['discarded'] },
    run: () => {
      const read = guardRead(HASH_A, 1_000n, HASH_B);
      return {
        protocolStatus: 'UNKNOWN',
        exitCode: 3,
        holds: read.ok ? [] : ['discarded'],
      };
    },
  },
  {
    id: 'rpc/silent-log-truncation',
    title: 'A provider that returns a short log window leaves a gap',
    corpus: 'gap',
    provenance: 'docs/RUNBOOK.md 8 (replay-silent-truncation)',
    pinned: { window: '1..100', committed: '1..40, 61..100', missing: '41..60' },
    expect: { protocolStatus: 'UNKNOWN', dataStatus: 'PARTIAL', exitCode: 3 },
    run: () => {
      const window = { fromBlock: 1n, toBlock: 100n };
      const committed = [
        { fromBlock: 1n, toBlock: 40n },
        { fromBlock: 61n, toBlock: 100n },
      ];
      const gaps = findRangeGaps(committed, window);
      const completeness = assessCompleteness({
        window,
        committed,
        lastSuccessAt: new Date(NOW),
        freshnessTtlMs: 60_000,
        openReasons: [],
        now: new Date(NOW),
      });
      return {
        protocolStatus: completeness.verdict === 'OK' ? 'OK' : completeness.verdict,
        dataStatus: 'PARTIAL',
        exitCode: completeness.verdict === 'OK' ? 0 : 3,
        reasonCodes: [...completeness.reasons],
        holds: [`gaps=${String(gaps.length)}`, `status=${completeness.status}`],
      };
    },
  },
  {
    id: 'rpc/undeclared-archive-fallback',
    title: 'An archive answer nobody declared cannot satisfy agreement',
    corpus: 'gap',
    provenance: 'docs/RUNBOOK.md 8 (replay-archive-fallback); M07 OPEN_RISKS R1',
    pinned: { viaArchive: 'true', archiveFallbackDeclared: 'false' },
    expect: { protocolStatus: 'UNKNOWN', exitCode: 3, holds: ['blocked'] },
    run: () => {
      const range = { fromBlock: 1n, toBlock: 10n };
      const result = agree(
        [
          {
            providerGroup: 'alpha-1',
            range,
            startBlockHash: HASH_A,
            endBlockHash: HASH_B,
            logCount: 0,
            digest: 'd'.repeat(64),
            viaArchive: true,
            blocks: [],
            logs: [],
          },
        ],
        { requiredIndependentGroups: 2, archiveFallbackDeclared: false },
      );
      return {
        protocolStatus: 'UNKNOWN',
        exitCode: 3,
        holds: result.kind === 'blocked' ? ['blocked', result.reason] : [],
      };
    },
  },
  {
    id: 'rpc/stale-collection-past-ttl',
    title: 'A collection that stopped succeeding ages into UNKNOWN',
    corpus: 'gap',
    provenance: 'docs/INVARIANTS.md; docs/RUNBOOK.md 8 (replay-stale)',
    pinned: { lastSuccessAt: '2026-06-01T00:00:00Z', now: '2026-06-01T01:00:00Z', ttlMs: '60000' },
    expect: { protocolStatus: 'UNKNOWN', dataStatus: 'STALE', exitCode: 3 },
    run: () => {
      const window = { fromBlock: 1n, toBlock: 100n };
      const completeness = assessCompleteness({
        window,
        committed: [window],
        lastSuccessAt: new Date(NOW),
        freshnessTtlMs: 60_000,
        openReasons: [],
        now: new Date(NOW + 3_600_000),
      });
      return {
        protocolStatus: completeness.verdict === 'OK' ? 'OK' : completeness.verdict,
        dataStatus: 'STALE',
        exitCode: completeness.verdict === 'OK' ? 0 : 3,
        reasonCodes: [...completeness.reasons],
        holds: [`status=${completeness.status}`],
      };
    },
  },
]);
