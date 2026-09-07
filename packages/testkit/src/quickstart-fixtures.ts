import {
  encodeProofInput,
  replayProof,
  domainSeparatedSha256,
  factDigest,
  stateCallDigest,
} from '@ictt-sentinel/evidence';
import { proofInput, remote } from './erc20-fixtures.js';
import type { AggregationInput, ReasonCode } from '@ictt-sentinel/invariant-core';
import type { BundleDraft } from '@ictt-sentinel/evidence';

/**
 * The three quickstart scenarios.
 *
 * Fictional and fully offline: no public RPC, no credentials, no network. They
 * exist so a new operator can see all three answers the product can give -
 * green, unknown, red - within minutes of cloning, and so the CLI's exit codes
 * are exercised end to end.
 */

export const QUICKSTART_SCENARIOS = ['healthy', 'disagreement', 'deficit'] as const;
export type QuickstartScenario = (typeof QUICKSTART_SCENARIOS)[number];

export const SCENARIO_SUMMARY: Readonly<Record<QuickstartScenario, string>> = {
  healthy: 'Canonical ERC20, reconciled, fully evidenced -> OK',
  disagreement: 'Independent providers disagree on a pinned block hash -> UNKNOWN',
  deficit: 'Remote supply exceeds home accounting under a closed cut -> CRITICAL',
};

const FIXED_TIME = '2026-06-01T00:00:00.000Z';
const EXPIRY = '2026-06-01T00:05:00.000Z';
const HOME = `0x${'aa'.repeat(32)}`;
const REMOTE = `0x${'bb'.repeat(32)}`;

/** Aggregation input per scenario, for the invariant engine. */
export const quickstartProof = (scenario: QuickstartScenario) => ({
  ...proofInput({
    remotes: [
      remote({
        remoteTotalSupply: scenario === 'deficit' ? 1100n : 1000n,
        remotePin: scenario !== 'disagreement',
      }),
    ],
    witnessGroups: scenario === 'disagreement' ? 1 : 2,
  }),
  deploymentId: `quickstart-${scenario}`,
});
export const quickstartAggregation = (scenario: QuickstartScenario): AggregationInput =>
  replayProof(quickstartProof(scenario)).aggregation;

interface ScenarioShape {
  readonly protocolStatus: 'OK' | 'WARN' | 'CRITICAL' | 'UNKNOWN';
  readonly dataStatus: 'COMPLETE' | 'STALE' | 'PARTIAL' | 'DIVERGENT' | 'UNKNOWN';
  readonly claimMode:
    'EXACT' | 'CAUSAL_EXACT' | 'SUFFICIENT_UPPER_BOUND' | 'INDETERMINATE' | 'UNSUPPORTED';
  readonly coverage: 'COMPLETE' | 'PARTIAL' | 'UNVERIFIED';
  readonly reasons: readonly ReasonCode[];
  readonly criticalRuleIds: readonly string[];
  readonly unknownRuleIds: readonly string[];
  readonly agreed: boolean;
  readonly missingEvidence: readonly string[];
}

const SHAPES: Readonly<Record<QuickstartScenario, ScenarioShape>> = {
  healthy: {
    protocolStatus: 'OK',
    dataStatus: 'COMPLETE',
    claimMode: 'CAUSAL_EXACT',
    coverage: 'COMPLETE',
    reasons: ['ACC-A00-RECONCILED', 'ACC-B00-COVERAGE-SUFFICIENT'],
    criticalRuleIds: [],
    unknownRuleIds: [],
    agreed: true,
    missingEvidence: [],
  },
  disagreement: {
    protocolStatus: 'UNKNOWN',
    dataStatus: 'DIVERGENT',
    claimMode: 'INDETERMINATE',
    coverage: 'UNVERIFIED',
    reasons: ['ACC-I04-NO-PINNED-BLOCK', 'AGG-M04-WITNESS-DIVERGENCE'],
    criticalRuleIds: [],
    unknownRuleIds: ['ACC-ERC20-CANONICAL'],
    agreed: false,
    missingEvidence: ['agreed pinned block hash for the remote chain'],
  },
  deficit: {
    protocolStatus: 'CRITICAL',
    dataStatus: 'COMPLETE',
    claimMode: 'CAUSAL_EXACT',
    coverage: 'COMPLETE',
    reasons: ['ACC-A01-EXCESS-REMOTE-REPRESENTATION'],
    criticalRuleIds: ['ACC-ERC20-CANONICAL'],
    unknownRuleIds: [],
    agreed: true,
    missingEvidence: [],
  },
};

/**
 * A complete bundle draft per scenario.
 *
 * Every value is fixed, so the content hash is stable across machines and runs -
 * which is exactly the property the determinism tests assert.
 */
export const quickstartBundleDraft = (scenario: QuickstartScenario): BundleDraft => {
  const s = SHAPES[scenario];
  const input = quickstartProof(scenario);
  const replayed = replayProof(input);
  const firstRemote = input.remotes[0];
  if (!firstRemote || !input.provenance.manifestHash || !input.provenance.policyHash)
    throw new Error('incomplete fixture provenance');
  const homeHash = `0x${(100).toString(16).padStart(64, '0')}`;
  const remoteHash = `0x${(200).toString(16).padStart(64, '0')}`;
  const factDigestA = factDigest(43114n, homeHash, `0x${'71'.repeat(32)}`, 0);
  const factDigestB = factDigest(43113n, remoteHash, `0x${'72'.repeat(32)}`, 1);

  return {
    core: {
      producer: {
        producer: 'ictt-sentinel',
        buildCommit: '0000000000000000000000000000000000000000',
        artifactChecksum: 'c'.repeat(64),
      },
      sourceLock: {
        sourceLockHash: domainSeparatedSha256(
          'ictt-sentinel/source-lock/v1',
          'fictional source-lock attestation',
        ),
        commitSha: '8fef6ef73767f4497a72d8348a0774a262e0c535',
        adapterId: 'ictt.token-home.erc20',
        adapterVersion: 1,
        adapterEpoch: 'epoch-1',
      },
      baseline: {
        manifestHash: input.provenance.manifestHash,
        policyHash: input.provenance.policyHash,
      },
      deploymentId: `quickstart-${scenario}`,
      fingerprints: [
        {
          role: 'erc20-token-home',
          blockchainId: HOME,
          runtimeCodeHash: `0x${'34'.repeat(32)}`,
          address: `0x${'11'.repeat(20)}`,
          implementationAddress: `0x${'22'.repeat(20)}`,
          implementationCodeHash: `0x${'33'.repeat(32)}`,
          proxyAdmin: `0x${'44'.repeat(20)}`,
          beacon: null,
          recognised: true,
        },
      ],
      chains: [
        {
          blockchainId: HOME,
          evmChainId: '43114',
          blockNumber: '100',
          blockHash: homeHash,
          blockTimestamp: '1700000100',
          acceptanceEvidence: 'allow-unfinalized-queries=false; latest is an accepted block',
          finalityBasis: 'accepted-quorum',
        },
        {
          blockchainId: REMOTE,
          evmChainId: '43113',
          blockNumber: '200',
          blockHash: remoteHash,
          blockTimestamp: '1700000200',
          acceptanceEvidence: 'allow-unfinalized-queries=false; latest is an accepted block',
          finalityBasis: 'accepted-quorum',
        },
      ],
      quorum: {
        votes: [
          ...['alpha', 'beta'].map((provider, i) => ({
            endpointId: `ep-000000000000001${String(i)}`,
            trustDomain: `provider-${provider}`,
            providerGroup: `provider-${provider}-prod`,
            blockchainId: HOME,
            agreedBlockHash: homeHash,
            agreed: true,
          })),
          {
            endpointId: 'ep-0000000000000001',
            trustDomain: 'provider-alpha',
            providerGroup: 'provider-alpha-prod',
            blockchainId: REMOTE,
            agreedBlockHash: remoteHash,
            agreed: true,
          },
          {
            endpointId: 'ep-0000000000000002',
            trustDomain: 'provider-beta',
            providerGroup: 'provider-beta-prod',
            blockchainId: REMOTE,
            agreedBlockHash: s.agreed ? remoteHash : `0x${'99'.repeat(32)}`,
            agreed: s.agreed,
          },
        ],
        independentGroups: s.agreed ? 2 : 1,
        requiredGroups: 2,
        note: 'Quorum counts independent provider groups. It is not a cryptographic or Byzantine guarantee: providers can share an upstream.',
      },
      rawFacts: [
        {
          evmChainId: '43114',
          blockHash: homeHash,
          txHash: `0x${'71'.repeat(32)}`,
          logIndex: 0,
          digest: factDigestA,
        },
        {
          evmChainId: '43113',
          blockHash: remoteHash,
          txHash: `0x${'72'.repeat(32)}`,
          logIndex: 1,
          digest: factDigestB,
        },
      ],
      stateCalls: [
        ...input.remotes.flatMap((r, i) => [
          {
            path: `remotes.${String(i)}.transferredBalance`,
            value: r.transferredBalance,
            chain: HOME,
            target: `0x${'11'.repeat(20)}`,
            number: '100',
            hash: homeHash,
            calldata: '0x01',
          },
          {
            path: `remotes.${String(i)}.remoteTotalSupply`,
            value: r.remoteTotalSupply,
            chain: REMOTE,
            target: r.remoteAddress,
            number: '200',
            hash: remoteHash,
            calldata: '0x18160ddd',
          },
        ]),
        {
          path: 'homeEscrow.escrowBalance',
          value: input.homeEscrow.escrowBalance,
          chain: HOME,
          target: `0x${'11'.repeat(20)}`,
          number: '100',
          hash: homeHash,
          calldata: '0x02',
        },
      ].map((c) => ({
        blockchainId: c.chain,
        target: c.target,
        observationPath: c.path,
        result: String(c.value),
        calldata: c.calldata,
        calldataDigest: domainSeparatedSha256('ictt-sentinel/calldata/v1', c.calldata),
        resultDigest: stateCallDigest(c.target, c.calldata, String(c.value)),
        blockNumber: c.number,
        blockHash: c.hash,
        provenance: 'fictional fixture state-call; not an RPC observation',
      })),
      census: {
        completeness: s.coverage === 'COMPLETE' ? 'complete-from-deployment-block' : 'partial',
        registeredRemotes: [`${REMOTE}/${firstRemote.remoteAddress}`],
        missingRemotes: [],
        remotesWithoutRpc: [],
      },
      messages: [
        {
          sourceBlockchainId: HOME,
          destinationBlockchainId: REMOTE,
          teleporterMessengerAddress: `0x${'ab'.repeat(20)}`,
          registryProtocolVersion: 1,
          messageId: `0x${'0abc'.padStart(64, '0')}`,
          state: scenario === 'deficit' ? 'EXECUTED_SUCCESS' : 'EXECUTED_SUCCESS',
          timeline: [
            { kind: 'source-accounted', factDigest: factDigestA },
            { kind: 'execution-succeeded', factDigest: factDigestB },
          ],
          sendAttempts: 1,
          executionAttempts: 1,
          envelopeIds: ['env-1'],
          economicEffectCount: 1,
        },
      ],
      replay: { input: encodeProofInput(input), evaluation: replayed.evaluation },
      rules: [replayed.rule],
      verdict: replayed.verdict,
      completeness: {
        observedAt: FIXED_TIME,
        expiresAt: EXPIRY,
        fresh: true,
        missingEvidence: s.missingEvidence,
        contradictoryEvidence: s.agreed
          ? []
          : ['provider-alpha and provider-beta report different block hashes at remote #200'],
      },
      assurance: {
        assuranceMode: 'FICTIONAL_OFFLINE_FIXTURE',
        assumptions: [
          'Quorum counts independent provider groups; it is not a cryptographic or Byzantine guarantee.',
          'Observed onchain state is coverage at the pinned blocks, not legal recoverability.',
        ],
        exclusions: [
          'Native token remotes, custom ERC20 remotes, rebase and fee-on-transfer wrappers.',
          'Multi-hop and remote-to-remote routes.',
        ],
        nonGoals: [
          'No signing, custody or wallet surface.',
          'No transaction sending, retry, pause or circuit breaker.',
          'No claim of absolute solvency or proof of reserves.',
        ],
      },
      previousBundleHash: null,
    },
    presentation: {
      generatedAt: FIXED_TIME,
      locale: 'en-US',
      toolVersion: '0.0.0',
    },
  };
};
