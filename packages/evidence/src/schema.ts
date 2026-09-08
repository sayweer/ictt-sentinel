import type {
  ClaimMode,
  CoverageState,
  DataStatus,
  ProtocolStatus,
  ReasonCode,
} from '@ictt-sentinel/invariant-core';

/**
 * Evidence bundle schema.
 *
 * The bundle is split in two on purpose:
 *
 *   `core`         - everything a verdict rests on. This is what gets hashed.
 *   `presentation` - when it was rendered, on which machine, in which locale.
 *                    Deliberately OUTSIDE the hash, so the same evidence
 *                    produced on two machines is byte-identical where it counts.
 *
 * The bundle is reproducible and audit-shareable. It is NOT tamper-proof,
 * immutable, or a Byzantine proof, and nothing in this package says otherwise:
 * anyone who can rewrite the file can rewrite the hash with it. What the hash
 * gives is detection of accidental or careless change, plus a stable identity
 * to reference (docs/DATA_MODEL.md 4).
 */

export const EVIDENCE_SCHEMA_VERSION = 'ictt-sentinel/evidence/v1' as const;
export type EvidenceSchemaVersion = typeof EVIDENCE_SCHEMA_VERSION;

/** Who produced this, and from which build. */
export interface ProducerIdentity {
  readonly producer: 'ictt-sentinel';
  readonly schemaVersion: EvidenceSchemaVersion;
  /** Build commit of the sentinel itself. Distinct from the source lock. */
  readonly buildCommit: string;
  /** Checksum of the built artifact, so two runs can be compared. */
  readonly artifactChecksum: string;
}

export interface SourceLockRef {
  /** Immutable upstream commit the contract semantics are bound to. */
  readonly commitSha: string;
  readonly sourceLockHash: string;
  readonly adapterId: string;
  readonly adapterVersion: number;
  /** Which adapter epoch interpreted the bytes. */
  readonly adapterEpoch: string;
}

export interface ApprovedBaselineRef {
  readonly manifestHash: string;
  readonly policyHash: string;
}

/** Exact deployment fingerprints, as observed at a pinned block. */
export interface ContractFingerprint {
  readonly role: string;
  readonly blockchainId: string;
  readonly runtimeCodeHash: string;
  readonly address: string;
  readonly implementationAddress: string | null;
  readonly implementationCodeHash: string | null;
  readonly proxyAdmin: string | null;
  readonly beacon: string | null;
  readonly recognised: boolean;
}

export interface PinnedChain {
  /** Avalanche ICM identity. Never an EVM chainId. */
  readonly blockchainId: string;
  readonly evmChainId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly blockTimestamp: string;
  /** How acceptance was established for this chain, named rather than assumed. */
  readonly acceptanceEvidence: string;
  readonly finalityBasis: string;
}

/**
 * One witness's vote on one pinned block.
 *
 * Endpoints appear as a pseudonymous id only. A URL or a token in an evidence
 * bundle is a credential leak the moment the bundle is shared, which is the
 * whole point of sharing it (docs/SECURITY.md).
 */
export interface WitnessVote {
  readonly endpointId: string;
  readonly trustDomain: string;
  readonly providerGroup: string;
  readonly blockchainId: string;
  readonly agreedBlockHash: string;
  readonly agreed: boolean;
}

export interface QuorumMatrix {
  readonly votes: readonly WitnessVote[];
  /** Counted over distinct provider groups, never over URLs. */
  readonly independentGroups: number;
  readonly requiredGroups: number;
  /**
   * Stated in the bundle itself so a reader cannot mistake it for more: this is
   * agreement between independent readers, not a cryptographic guarantee.
   */
  readonly note: string;
}

/** A raw fact, by its full coordinate. */
export interface RawFactRefRecord {
  readonly evmChainId: string;
  readonly blockHash: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly digest: string;
}

/** A state call, recorded so it can be replayed against the same block. */
export interface StateCallRecord {
  readonly blockchainId: string;
  readonly target: string;
  readonly calldataDigest: string;
  readonly resultDigest: string;
  readonly observationPath: string;
  readonly result: string;
  readonly calldata: string;
  readonly provenance: string;
  readonly blockNumber: string;
  readonly blockHash: string;
}

export interface CensusRecord {
  readonly completeness: string;
  readonly registeredRemotes: readonly string[];
  /** Remotes the census knows about but could not observe. Never zero-liability. */
  readonly missingRemotes: readonly string[];
  readonly remotesWithoutRpc: readonly string[];
}

/** A message, by its composite key, with its transition timeline. */
export interface MessageRecord {
  readonly sourceBlockchainId: string;
  readonly destinationBlockchainId: string;
  readonly teleporterMessengerAddress: string;
  readonly registryProtocolVersion: number;
  readonly messageId: string;
  readonly state: string;
  readonly timeline: readonly { readonly kind: string; readonly factDigest: string }[];
  /** Send attempts, execution attempts and envelopes, kept apart. */
  readonly sendAttempts: number;
  readonly executionAttempts: number;
  readonly envelopeIds: readonly string[];
  readonly economicEffectCount: number;
}

/** Rule inputs and every intermediate, so the arithmetic can be re-done. */
export interface RuleRecord {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly result: string;
  readonly reasonCodes: readonly ReasonCode[];
  /** bigints as canonical decimal strings; JSON numbers are doubles. */
  readonly inputs: Readonly<Record<string, string>>;
  readonly intermediates: Readonly<Record<string, string>>;
  readonly unit: string;
  readonly floor: string | null;
  readonly ceil: string | null;
  readonly dust: string | null;
}

export interface VerdictRecord {
  readonly protocolStatus: ProtocolStatus;
  readonly dataStatus: DataStatus;
  readonly claimMode: ClaimMode;
  readonly coverage: CoverageState;
  readonly reasonCodes: readonly ReasonCode[];
  readonly criticalRuleIds: readonly string[];
  readonly unknownRuleIds: readonly string[];
}

export interface CompletenessRecord {
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly fresh: boolean;
  /** Evidence that was required and is absent. Listed, never omitted. */
  readonly missingEvidence: readonly string[];
  /** Observations that contradict each other. */
  readonly contradictoryEvidence: readonly string[];
}

export interface AssuranceRecord {
  readonly assuranceMode: string;
  readonly assumptions: readonly string[];
  readonly exclusions: readonly string[];
  /** Things this product deliberately never does. */
  readonly nonGoals: readonly string[];
}

/** Everything the hash covers. */
export interface EvidenceCore {
  readonly producer: ProducerIdentity;
  readonly sourceLock: SourceLockRef;
  readonly baseline: ApprovedBaselineRef;
  readonly deploymentId: string;
  readonly fingerprints: readonly ContractFingerprint[];
  readonly chains: readonly PinnedChain[];
  readonly quorum: QuorumMatrix;
  readonly rawFacts: readonly RawFactRefRecord[];
  /** Historical fact blocks preceding the comparative state pins. */
  readonly historicalBlocks?: readonly {
    readonly blockchainId: string;
    readonly blockNumber: string;
    readonly blockHash: string;
    readonly acceptanceEvidence: string;
    readonly votes: readonly WitnessVote[];
  }[];
  readonly stateCalls: readonly StateCallRecord[];
  readonly census: CensusRecord;
  readonly messages: readonly MessageRecord[];
  readonly rules: readonly RuleRecord[];
  readonly verdict: VerdictRecord;
  readonly completeness: CompletenessRecord;
  readonly assurance: AssuranceRecord;
  /** Optional link to the previous bundle, for a tamper-EVIDENT sequence. */
  readonly previousBundleHash: string | null;
  /** Self-contained pure engine input and complete recorded proof. */
  readonly replay: {
    readonly input: import('./canonical.js').CanonicalValue;
    readonly evaluation: import('./canonical.js').CanonicalValue;
  };
}

/**
 * Rendering metadata. Outside the hash by design.
 *
 * If `generatedAt` were hashed, the same evidence would get a different identity
 * on every run and the reproducibility promise would be untestable.
 */
export interface EvidencePresentation {
  readonly generatedAt: string;
  readonly locale: string;
  readonly toolVersion: string;
}

export interface EvidenceBundle {
  readonly core: EvidenceCore;
  readonly presentation: EvidencePresentation;
  /** Domain-separated SHA-256 over the canonical form of `core`. */
  readonly contentHash: string;
}
