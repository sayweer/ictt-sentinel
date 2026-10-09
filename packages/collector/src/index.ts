// @ictt-sentinel/collector
// Live, witnessed collection of canonical ERC20 economic evidence.
//
// Reads every approved chain at a pin through independent witnesses, requires
// their complete readings to agree, and builds an evidence bundle the offline
// verifier accepts - or answers UNKNOWN with the reason named.
//
// See docs/adr/0014-live-economic-collector.md.

export const PACKAGE_NAME = '@ictt-sentinel/collector' as const;

export {
  PENDING_AGE_LIMIT_SECONDS,
  RULE_VERSION,
  collectConfigured,
  type CollectResult,
} from './collect.js';
export {
  assessRoute,
  type Delivery,
  type Fact,
  type LogCoordinate,
  type MessageTrace,
  type OpenEdge,
  type PinRef,
  type Route,
  type RouteAssessment,
  type SideFacts,
} from './model.js';
export {
  deployments,
  probeDeployment,
  witnessId,
  type ChainPin,
  type ChainReader,
} from './probe.js';
export {
  CollectionBoundExceeded,
  ReadingRefused,
  agreeOnReadings,
  readChain,
  type CallQuery,
  type ChainReading,
  type LogQuery,
  type RawLog,
} from './read.js';
export { SOURCE_LOCK_DOCUMENT_DIGEST } from './source-lock.js';
export { ProviderValueError, bytes32, hexQuantity, object } from './values.js';
