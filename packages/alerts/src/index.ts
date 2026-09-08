// @ictt-sentinel/alerts
//
// Outbound alerting. Never writes a canonical fact and never changes a verdict.
//
// Three separable concerns, kept apart on purpose:
//
//   dedup + lifecycle   what an alert IS and how it evolves. Pure, deterministic,
//                       restart-safe, and the reason a rolling restart does not
//                       page an on-call engineer twice for one incident.
//   sanitize + sharing  what may leave the operator's machine. Allowlisted
//                       construction, not field deletion.
//   notify              one bounded attempt per target, behind an SSRF guard.
//                       Failure is reported, never converted into a judgement.

export const PACKAGE_NAME = '@ictt-sentinel/alerts' as const;

export { dedupKey, incidentKey, isEscalation, isRecovery } from './dedup.js';
export type { AlertIdentity } from './dedup.js';

export { ALERT_STATES, acknowledge, observe, open, recover, shouldNotify } from './lifecycle.js';
export type { AlertRecord, AlertState, Observation } from './lifecycle.js';

export { TARGET_KINDS, checkTargetUrl, meetsThreshold } from './target.js';
export type { AlertTarget, TargetCheck, TargetKind } from './target.js';

export {
  ForbiddenClaimError,
  NOTIFICATION_SCHEMA,
  UnsanitizableAlertError,
  assertBoundedLanguage,
  decodeNotification,
  sanitize,
} from './sanitize.js';
export type { AlertContext, NotificationPayload } from './sanitize.js';

export { DEFAULT_SHARING_LEVEL, SHARING_LEVELS, isSharingLevel, project } from './sharing.js';
export type { SanitizedMetadata, SharedEvidence, SharingLevel } from './sharing.js';

export { deliver, dispatch, httpTransport } from './notify.js';
export type {
  DeliverOptions,
  DeliveryOutcome,
  DeliveryReport,
  DispatchResult,
  NotifierTransport,
} from './notify.js';
