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
export const quickstartAggregation = (scenario: QuickstartScenario): AggregationInput => {
  switch (scenario) {
    case 'healthy':
      return {
        contributions: [
          {
            ruleId: 'ACC-ERC20-CANONICAL',
            result: 'PASS',
            critical: false,
            required: true,
            claimMode: 'CAUSAL_EXACT',
            reasons: ['ACC-A00-RECONCILED', 'ACC-B00-COVERAGE-SUFFICIENT'],
          },
        ],
        dataStatus: 'COMPLETE',
        coverage: 'COMPLETE',
        missingRequiredEvaluations: [],
        previousOkExpired: false,
        evaluationFaults: [],
      };
    case 'disagreement':
      return {
        contributions: [
          {
            ruleId: 'ACC-ERC20-CANONICAL',
            result: 'UNKNOWN',
            critical: false,
            required: true,
            claimMode: 'INDETERMINATE',
            reasons: ['ACC-I04-NO-PINNED-BLOCK'],
          },
        ],
        // Witnesses disagreeing is a data fault, not an economic finding.
        dataStatus: 'DIVERGENT',
        coverage: 'UNVERIFIED',
        missingRequiredEvaluations: [],
        previousOkExpired: false,
        evaluationFaults: [],
      };
    case 'deficit':
      return {
        contributions: [
          {
            ruleId: 'ACC-ERC20-CANONICAL',
            result: 'FAIL',
            critical: true,
            required: true,
            claimMode: 'CAUSAL_EXACT',
            reasons: ['ACC-A01-EXCESS-REMOTE-REPRESENTATION'],
          },
        ],
        dataStatus: 'COMPLETE',
        coverage: 'COMPLETE',
        missingRequiredEvaluations: [],
        previousOkExpired: false,
        evaluationFaults: [],
      };
  }
};

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
  const factDigestA = 'a'.repeat(64);
  const factDigestB = 'b'.repeat(64);

  return {
    core: {
      producer: {
        producer: 'ictt-sentinel',
        buildCommit: '0000000000000000000000000000000000000000',
        artifactChecksum: 'c'.repeat(64),
      },
      sourceLock: {
        commitSha: '8fef6ef73767f4497a72d8348a0774a262e0c535',
        adapterId: 'ictt.token-home.erc20',
        adapterVersion: 1,
        adapterEpoch: 'epoch-1',
      },
      baseline: { manifestHash: 'd'.repeat(64), policyHash: 'e'.repeat(64) },
      deploymentId: `quickstart-${scenario}`,
      fingerprints: [
        {
          role: 'erc20-token-home',
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
          blockHash: `0x${'64'.repeat(32)}`,
          blockTimestamp: '1700000100',
          acceptanceEvidence: 'allow-unfinalized-queries=false; latest is an accepted block',
          finalityBasis: 'accepted-quorum',
        },
        {
          blockchainId: REMOTE,
          evmChainId: '43113',
          blockNumber: '200',
          blockHash: `0x${'c8'.repeat(32)}`,
          blockTimestamp: '1700000200',
          acceptanceEvidence: 'allow-unfinalized-queries=false; latest is an accepted block',
          finalityBasis: 'accepted-quorum',
        },
      ],
      quorum: {
        votes: [
          {
            endpointId: 'ep-0000000000000001',
            trustDomain: 'provider-alpha',
            providerGroup: 'provider-alpha-prod',
            blockchainId: REMOTE,
            agreedBlockHash: `0x${'c8'.repeat(32)}`,
            agreed: true,
          },
          {
            endpointId: 'ep-0000000000000002',
            trustDomain: 'provider-beta',
            providerGroup: 'provider-beta-prod',
            blockchainId: REMOTE,
            agreedBlockHash: s.agreed ? `0x${'c8'.repeat(32)}` : `0x${'99'.repeat(32)}`,
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
          blockHash: `0x${'64'.repeat(32)}`,
          txHash: `0x${'71'.repeat(32)}`,
          logIndex: 0,
          digest: factDigestA,
        },
        {
          evmChainId: '43113',
          blockHash: `0x${'c8'.repeat(32)}`,
          txHash: `0x${'72'.repeat(32)}`,
          logIndex: 1,
          digest: factDigestB,
        },
      ],
      stateCalls: [
        {
          blockchainId: HOME,
          target: `0x${'11'.repeat(20)}`,
          calldataDigest: '1'.repeat(64),
          resultDigest: '2'.repeat(64),
          blockNumber: '100',
          blockHash: `0x${'64'.repeat(32)}`,
        },
      ],
      census: {
        completeness: s.coverage === 'COMPLETE' ? 'complete-from-deployment-block' : 'partial',
        registeredRemotes: [`${REMOTE}/0x${'55'.repeat(20)}`],
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
      rules: [
        {
          ruleId: 'ACC-ERC20-CANONICAL',
          ruleVersion: 'acc-erc20-canonical@1',
          result:
            s.protocolStatus === 'OK'
              ? 'PASS'
              : s.protocolStatus === 'CRITICAL'
                ? 'FAIL'
                : 'UNKNOWN',
          reasonCodes: s.reasons,
          inputs: {
            transferredBalance: scenario === 'deficit' ? '1000' : '1000',
            remoteTotalSupply: scenario === 'deficit' ? '1100' : '1000',
            pendingTotal: '0',
          },
          intermediates: { delta: scenario === 'deficit' ? '-100' : '0' },
          unit: 'remote-base-units',
          floor: '0',
          ceil: '1',
          dust: '1',
        },
      ],
      verdict: {
        protocolStatus: s.protocolStatus,
        dataStatus: s.dataStatus,
        claimMode: s.claimMode,
        coverage: s.coverage,
        reasonCodes: s.reasons,
        criticalRuleIds: s.criticalRuleIds,
        unknownRuleIds: s.unknownRuleIds,
      },
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
        assuranceMode: 'ACCEPTED_STATE_ASSURANCE',
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
