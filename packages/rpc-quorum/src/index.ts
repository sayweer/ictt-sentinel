// @ictt-sentinel/rpc-quorum
// Read-only, query-only-allowlist multi-provider RPC witness quorum.
//
// There is no generic request(method, params) surface, no signer, no wallet and
// no transaction envelope anywhere in this package. Callers describe a domain
// operation; this package maps it to a closed list of read methods.
//
// Quorum is counted over independent trust domains, never over URLs, and it is
// not a cryptographic or Byzantine proof: providers can share an upstream.

export const PACKAGE_NAME = '@ictt-sentinel/rpc-quorum' as const;

export {
  ALLOWED_METHODS,
  BLOCK_TAGS,
  FORBIDDEN_METHODS,
  FORBIDDEN_METHOD_PREFIXES,
  assertSendable,
  isAllowedMethod,
  isForbiddenMethod,
  toBlockParam,
  type AllowedMethod,
  type BlockRef,
  type BlockTag,
} from './methods.js';

export {
  NEVER_RETRY,
  RPC_FAULTS,
  RpcError,
  RpcIntegrityConflict,
  TRANSIENT_FAULTS,
  faultForJsonRpcError,
  faultForStatus,
  isTransient,
  type RpcFault,
  type RpcFaultDetail,
} from './errors.js';

export {
  DEFAULT_TRANSPORT_POLICY,
  checkEndpointUrl,
  jsonDepth,
  sendChecked,
  type EndpointDescriptor,
  type RpcRequest,
  type RpcResponse,
  type Transport,
  type TransportPolicy,
  type UrlCheck,
} from './transport.js';

export {
  ALLOWLIST_READ_SIG,
  PRECOMPILES,
  WARP_GET_BLOCKCHAIN_ID_SIG,
  assertLogRange,
  buildRequest,
  readAllowListCalldata,
  warpGetBlockchainIdCalldata,
  type ReadOperation,
} from './operations.js';

export {
  WITNESS_REJECTIONS,
  assertNoIntegrityConflict,
  evaluateQuorum,
  type AcceptedRecord,
  type ExpectedIdentity,
  type QuorumOutcome,
  type QuorumPolicy,
  type QuorumResult,
  type RejectedWitness,
  type WitnessObservation,
  type WitnessRejection,
} from './quorum.js';

export {
  CONCLUSIVE_SIGNALS,
  correlateEndpoints,
  independenceGroups,
  type CorrelationFinding,
  type CorrelationResult,
  type CorrelationSignal,
  type EndpointCorrelationInput,
  type IndependenceClaim,
} from './independence.js';

export {
  ACCEPTED_STATE_EVIDENCE,
  buildPinnedContext,
  decideFinalityBasis,
  finalityFromConfirmationDepth,
  guardRead,
  isExpired,
  reconstructBlockHashLocally,
  type AcceptedStateEvidence,
  type EndpointCapability,
  type FinalityDecision,
  type GuardedRead,
  type PinInput,
  type PinResult,
  type PinnedBlockContext,
  type TagProbe,
} from './pinned.js';

export {
  ASSURANCE_MODE,
  FORBIDDEN_ASSURANCE_CLAIMS,
  GATE_B_CAPABILITIES,
  evaluateGateA,
  gateBStatus,
  requireGateB,
  type AssuranceMode,
  type GateAInput,
  type GateAResult,
  type GateBCapability,
  type GateBStatus,
} from './gates.js';
