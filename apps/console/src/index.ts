// @ictt-sentinel/console
//
// Read-only operator console for the hosted evidence API.
//
// This entry exports the presentation MODEL, not the React tree: the rules that
// decide what an operator is told - which tone a verdict gets, which vocabulary
// a claim uses, how a base-unit amount is rendered, when a screen admits it is
// stuck - are pure functions with their own tests, and the components are thin
// renderers over them.
//
// The console can read and nothing else. It holds no key, connects to no RPC
// endpoint, offers no wallet and exposes no action that changes a chain or
// approves a baseline.

export const PACKAGE_NAME = '@ictt-sentinel/console' as const;

export { API_VERSION } from './api/contract.js';
export type {
  DataStatus,
  DeploymentGrant,
  DeploymentStatus,
  EvidenceDetailResponse,
  EvidenceRecord,
  MessageRow,
  ProtocolStatus,
  SharingLevel,
  VerifyStatus,
} from './api/contract.js';

export { ApiClient, ApiFailure } from './api/client.js';
export type { ClientOptions, FailureKind } from './api/client.js';
export { ContractError } from './api/decode.js';

export { TONES, dataBadge, isHealthyTone, protocolBadge, statusView } from './model/verdict.js';
export type { Badge, StatusView, Tone } from './model/verdict.js';

export {
  ASSET_MODES,
  CLAIM_MODES,
  COVERAGE_CAVEAT,
  COVERAGE_STATES,
  FORBIDDEN_CLAIMS,
  ForbiddenClaimError,
  NATIVE_PANEL_CAVEAT,
  assertBoundedLanguage,
  claimCopy,
  coverageCopy,
} from './model/claim.js';
export type { AssetMode, ClaimCopy, ClaimMode, CoverageState } from './model/claim.js';

export {
  TIMEZONE_NOTE,
  formatAge,
  formatAmount,
  formatBaseUnits,
  formatBlockNumber,
  formatInstant,
  shortDigest,
  viewerTimeZone,
} from './model/format.js';

export {
  CONDITIONS,
  SLOW_AFTER_MS,
  conditionCopy,
  deriveCondition,
  empty,
  failed,
  isHealthyCondition,
  loading,
  notConfigured,
  ready,
} from './model/screen.js';
export type { Condition, ConditionCopy, ScreenState } from './model/screen.js';

export { DEPLOYMENT_TABS, documentTitle, parseRoute, routeHash } from './model/route.js';
export type { PageName, Route } from './model/route.js';

export { deriveIncidents } from './model/incidents.js';
export type { Incident } from './model/incidents.js';

export {
  BASELINE_CHECKLIST,
  NO_APPROVAL_IN_BROWSER,
  PastedSecretError,
  reviewDiscovery,
} from './model/onboarding.js';
export type { ChainSummary, DiscoveryReview, EndpointSummary } from './model/onboarding.js';

export {
  OFFLINE_VERIFICATION_NOTE,
  assetModeOf,
  censusPanel,
  chainPanels,
  downloadPayload,
  fingerprintPanels,
  provenancePanel,
  quorumPanel,
  rulePanels,
  verdictPanel,
} from './model/bundle.js';
export type {
  CensusPanel,
  ChainPanel,
  FingerprintPanel,
  ProvenancePanel,
  QuorumPanel,
  RulePanel,
  VerdictPanel,
} from './model/bundle.js';
