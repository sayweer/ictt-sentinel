import type { EvidenceBundle } from '@ictt-sentinel/evidence';
import type {
  DataStatus,
  DeploymentStatus,
  EvidenceRecord,
  MessageRow,
  ProtocolStatus,
} from '../src/api/contract.js';

/**
 * Fixtures.
 *
 * Built here rather than imported from `@ictt-sentinel/testkit`: the console
 * depends on the API contract, not on the engine's test corpus, and a fixture
 * that drifts with the engine would make console snapshots fail for reasons
 * that have nothing to do with the console.
 *
 * `NOW` is fixed so every age, every snapshot and every stale calculation is
 * identical on every machine and in every year.
 */

export const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const hex = (c: string, n = 64): string => c.repeat(n);

export const statusFixture = (overrides: Partial<DeploymentStatus> = {}): DeploymentStatus => ({
  deploymentId: 'acme-usdc',
  evidenceDigest: hex('a'),
  sharingLevel: 'approved-full',
  verifyStatus: 'verified',
  protocolStatus: 'OK',
  dataStatus: 'COMPLETE',
  observedAt: '2026-06-01T11:30:00.000Z',
  expiresAt: '2026-06-01T12:30:00.000Z',
  receivedAt: '2026-06-01T11:30:05.000Z',
  stale: false,
  currentProtocolStatus: 'OK',
  currentDataStatus: 'COMPLETE',
  ...overrides,
});

export const recordFixture = (
  digest: string,
  protocolStatus: ProtocolStatus = 'OK',
  dataStatus: DataStatus = 'COMPLETE',
  observedAt = '2026-06-01T11:30:00.000Z',
): EvidenceRecord => ({
  deploymentId: 'acme-usdc',
  evidenceDigest: digest,
  sharingLevel: 'approved-full',
  verifyStatus: 'verified',
  protocolStatus,
  dataStatus,
  observedAt,
  expiresAt: '2026-06-01T12:30:00.000Z',
  receivedAt: observedAt,
});

/**
 * A hostile string.
 *
 * Contract metadata is attacker-controlled: a token symbol, a rule id, a reason
 * code all originate on a chain someone else can deploy to. It is used
 * throughout these fixtures on purpose.
 */
export const HOSTILE = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';

export const bundleFixture = (
  overrides: {
    readonly native?: boolean;
    readonly claimMode?: string;
    readonly coverage?: string;
    readonly missingRemotes?: readonly string[];
    readonly divergent?: boolean;
    readonly hostile?: boolean;
  } = {},
): EvidenceBundle => {
  const native = overrides.native === true;
  const hostile = overrides.hostile === true;
  const label = (value: string): string => (hostile ? `${value}${HOSTILE}` : value);
  return {
    contentHash: hex('a'),
    presentation: {
      generatedAt: '2026-06-01T11:30:00.000Z',
      locale: 'en',
      toolVersion: '0.0.0',
    },
    core: {
      producer: {
        producer: 'ictt-sentinel',
        schemaVersion: 'ictt-sentinel/evidence/v1',
        buildCommit: 'artifact-addressed',
        artifactChecksum: hex('b'),
      },
      sourceLock: {
        commitSha: '8fef6ef73767f4497a72d8348a0774a262e0c535',
        sourceLockHash: hex('c'),
        adapterId: label('ictt-erc20'),
        adapterVersion: 1,
        adapterEpoch: '2026-01-01',
      },
      baseline: { manifestHash: hex('d'), policyHash: hex('e') },
      deploymentId: 'acme-usdc',
      fingerprints: [
        {
          role: label(native ? 'native-token-remote' : 'erc20-token-remote'),
          blockchainId: `0x${hex('1')}`,
          runtimeCodeHash: `0x${hex('2')}`,
          address: `0x${hex('3', 40)}`,
          implementationAddress: null,
          implementationCodeHash: null,
          proxyAdmin: null,
          beacon: null,
          recognised: true,
        },
      ],
      chains: [
        {
          blockchainId: `0x${hex('1')}`,
          evmChainId: '43114',
          blockNumber: '18446744073709551617',
          blockHash: `0x${hex('4')}`,
          blockTimestamp: '1780000000',
          acceptanceEvidence: label('accepted-quorum'),
          finalityBasis: label('avalanche-acceptance'),
        },
      ],
      quorum: {
        votes: [
          {
            endpointId: 'ep-0123456789abcdef',
            trustDomain: label('alpha'),
            providerGroup: label('alpha-1'),
            blockchainId: `0x${hex('1')}`,
            agreedBlockHash: `0x${hex('4')}`,
            agreed: true,
          },
          {
            endpointId: 'ep-fedcba9876543210',
            trustDomain: 'beta',
            providerGroup: 'beta-1',
            blockchainId: `0x${hex('1')}`,
            agreedBlockHash: `0x${hex('5')}`,
            agreed: overrides.divergent !== true,
          },
        ],
        independentGroups: 2,
        requiredGroups: 2,
        note: 'Agreement between independent readers. Not a cryptographic or Byzantine guarantee.',
      },
      rawFacts: [],
      stateCalls: [],
      census: {
        completeness: label(overrides.missingRemotes === undefined ? 'complete' : 'partial'),
        registeredRemotes: [`0x${hex('3', 40)}`],
        missingRemotes: overrides.missingRemotes ?? [],
        remotesWithoutRpc: [],
      },
      messages: [],
      rules: [
        {
          ruleId: label(native ? 'native-upper-bound' : 'gate-a-conservation'),
          ruleVersion: '1',
          result: 'PASS',
          reasonCodes: [],
          inputs: {
            transferredBalance: '340282366920938463463374607431768211455',
            remoteSupply: '340282366920938463463374607431768211455',
          },
          intermediates: { difference: '0' },
          unit: 'base-units',
          floor: null,
          ceil: null,
          dust: null,
        },
      ],
      verdict: {
        protocolStatus: 'OK',
        dataStatus: 'COMPLETE',
        claimMode: (overrides.claimMode ?? (native ? 'SUFFICIENT_UPPER_BOUND' : 'EXACT')) as never,
        coverage: (overrides.coverage ?? 'COMPLETE') as never,
        reasonCodes: [],
        criticalRuleIds: [],
        unknownRuleIds: [],
      },
      completeness: {
        observedAt: '2026-06-01T11:30:00.000Z',
        expiresAt: '2026-06-01T12:30:00.000Z',
        fresh: true,
        missingEvidence: [],
        contradictoryEvidence: [],
      },
      assurance: {
        assuranceMode: 'observed-onchain-coverage',
        assumptions: [label('Providers do not share an undisclosed upstream.')],
        exclusions: ['Contract source audit.'],
        nonGoals: ['Preventing an exploit.'],
      },
      previousBundleHash: null,
      replay: { input: {}, evaluation: {} },
    },
  };
};

export const messageFixture = (overrides: Partial<MessageRow> = {}): MessageRow => ({
  evidenceDigest: hex('a'),
  sourceBlockchainId: `0x${hex('1')}`,
  destinationBlockchainId: `0x${hex('2')}`,
  teleporterMessengerAddress: `0x${hex('6', 40)}`,
  registryProtocolVersion: 1,
  messageId: `0x${hex('7')}`,
  state: 'delivered',
  timeline: [
    { kind: 'icm-sent', factDigest: hex('8') },
    { kind: 'delivered', factDigest: hex('9') },
  ],
  sendAttempts: 1,
  executionAttempts: 2,
  envelopeIds: [`0x${hex('a')}`],
  economicEffectCount: 1,
  ...overrides,
});
