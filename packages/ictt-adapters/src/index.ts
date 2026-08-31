// @ictt-sentinel/ictt-adapters
// Version-pinned ICTT/Teleporter contract read adapters.
//
// Contract semantics are bound to one immutable upstream commit. Nothing is
// fetched at runtime, no adapter is selected by a version number, and an
// unrecognised contract is never interpreted.
//
// See docs/adr/0006-protocol-and-sdk-source-lock.md.

export const PACKAGE_NAME = '@ictt-sentinel/ictt-adapters' as const;

export {
  AUDIT_RECORDS,
  CONTRACT_ROLES,
  PROTOCOL_FAMILIES,
  SUPPORT_LEVELS,
  auditCoverageFor,
  validateDescriptor,
  type AuditCoverage,
  type AuditRecord,
  type ContractRole,
  type ProtocolFamily,
  type SourceDescriptor,
  type SupportLevel,
} from './descriptor.js';

export {
  PINNED_BUILD,
  PINNED_COMMIT_SHA,
  PINNED_LIBRARIES,
  PINNED_REPOSITORY,
  SOURCE_DESCRIPTORS,
} from './descriptors/generated.js';

export {
  MAX_TOKEN_DECIMALS,
  MAX_UINT256,
  applyTokenScale,
  deriveCollateralNeeded,
  deriveTokenMultiplierValues,
  removeTokenScale,
  type DeriveResult,
  type ScalingFailure,
  type ScalingResult,
  type TokenMultiplierValues,
} from './scaling.js';

export {
  EIP1967_SLOTS,
  FINGERPRINT_CLASSES,
  canonicalSignature,
  classifyFingerprint,
  codeHash,
  epochAt,
  eventTopic0,
  functionSelector,
  isInterpretable,
  keccak256Hex,
  type AbiEntry,
  type AbiParameter,
  type AdapterEpoch,
  type ApprovedCodeHashes,
  type EpochLookup,
  type FingerprintClass,
  type FingerprintResult,
  type ObservedContract,
} from './fingerprint.js';

export {
  INTERPRETABLE_FAMILIES,
  familyFromRegistryVersion,
  getDescriptor,
  listDescriptors,
  resolveAdapter,
  sourceLockSummary,
  type AdapterResolution,
  type ResolutionOutcome,
  type SourceLockSummary,
} from './registry.js';

export {
  UNSUPPORTED_TRANSFER_SHAPES,
  impliesSuccessfulExecution,
  transferShapeSupport,
  type CollateralAddedObservation,
  type IcttObservation,
  type MessageExecutedObservation,
  type MessageExecutionFailedObservation,
  type MessageReceivedObservation,
  type MessageSentObservation,
  type NativeReportedSupplyObservation,
  type Observation,
  type ObservationSource,
  type ReceiptObservation,
  type RemoteCollateralizedObservation,
  type RemoteRegisteredObservation,
  type RemoteSettingsObservation,
  type TeleporterObservation,
  type TransferredBalanceObservation,
  type UnsupportedTransferShape,
} from './observations.js';

export {
  CENSUS_COMPLETENESS,
  DRIFT_KINDS,
  buildCandidateCensus,
  diffAgainstBaseline,
  requireApprovedBaseline,
  type ApprovedRemote,
  type BaselineGate,
  type CandidateCensus,
  type CandidateRemote,
  type CensusCompleteness,
  type CensusInput,
  type DiscoveryDiff,
  type DriftEntry,
  type DriftKind,
} from './discovery.js';

export {
  LINKAGE_FAULTS,
  checkLinkage,
  scaleForPair,
  type HomeSideLinkage,
  type LinkageFault,
  type LinkageFinding,
  type LinkageResult,
  type RemoteSideLinkage,
} from './linkage.js';
