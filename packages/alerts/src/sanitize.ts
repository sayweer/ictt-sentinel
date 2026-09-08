import { assertSecretFree } from '@ictt-sentinel/evidence';
import type { Verdict } from '@ictt-sentinel/domain';
import type { AlertState } from './lifecycle.js';

/**
 * The notifier payload.
 *
 * Slack, PagerDuty and a generic webhook are third-party surfaces outside this
 * product's trust boundary. What they get is deliberately the smallest thing
 * that lets a human decide whether to open the runbook:
 *
 *   severity, reason codes, a bounded-language summary, freshness, and a
 *   REFERENCE to the evidence.
 *
 * What they never get: the evidence bundle, a manifest, an RPC URL or endpoint
 * id, an auth value, a DSN, or any raw observed payload. A webhook URL is a
 * shared secret sitting in someone's chat integration, and a bundle posted into
 * it is a bundle published (docs/SECURITY.md).
 */

export const NOTIFICATION_SCHEMA = 'ictt-sentinel/alert-notification/v1' as const;

export interface AlertContext {
  readonly dedupKey: string;
  readonly deploymentId: string;
  readonly ruleId: string;
  readonly state: AlertState;
  readonly severity: Verdict;
  readonly occurrences: number;
  /** Machine codes only. Free-form upstream text never reaches a notifier. */
  readonly reasonCodes: readonly string[];
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly fresh: boolean;
  readonly evidenceHash: string;
  readonly evidenceSchemaVersion: string;
}

export interface NotificationPayload {
  readonly schema: typeof NOTIFICATION_SCHEMA;
  readonly dedupKey: string;
  readonly deploymentId: string;
  readonly ruleId: string;
  readonly state: AlertState;
  readonly severity: Verdict;
  readonly occurrences: number;
  readonly reasonCodes: readonly string[];
  readonly summary: string;
  readonly freshness: {
    readonly observedAt: string;
    readonly expiresAt: string;
    readonly fresh: boolean;
  };
  /**
   * How to find the evidence, not the evidence. A relative path, because an
   * absolute URL here would be this product telling a third party where its
   * hosted plane lives - and the recipient already knows where it reached us.
   *
   * The path addresses the alert record, which is what a responder opens; the
   * record links onward to the evaluation and to the exported bundle when one
   * exists. `contentHash` is the digest the verdict rested on, so a reader can
   * tell two pages about the same rule apart without fetching anything.
   */
  readonly evidence: {
    readonly contentHash: string;
    readonly schemaVersion: string;
    readonly retrievePath: string;
  };
}

/**
 * Wording per severity.
 *
 * Every sentence is a statement about what was observed at pinned blocks. None
 * of them claims solvency, a proof of reserves or a guarantee, and the
 * `assertBoundedLanguage` gate below is what keeps it that way (CLAUDE.md 9).
 */
const SUMMARY: Readonly<Record<Verdict, string>> = {
  OK: 'Observed onchain coverage reconciled at the pinned blocks.',
  WARN: 'Policy or liveness deviation observed. This is not evidence of an economic breach.',
  UNKNOWN:
    'Could not be established from the available evidence. Treat as unresolved, not as healthy.',
  CRITICAL: 'Deterministic accounting breach observed with sufficient evidence at pinned blocks.',
};

const STATE_PREFIX: Readonly<Record<AlertState, string>> = {
  first_seen: 'Opened',
  repeated: 'Still open',
  escalated: 'Escalated',
  acknowledged: 'Acknowledged (paging muted; the condition may still be live)',
  recovered: 'Recovered',
};

/** Claims this product cannot make, checked on the way out rather than trusted. */
const FORBIDDEN_CLAIMS: readonly RegExp[] = [
  /\bproof of reserves\b/i,
  /\bsolvent\b/i,
  /\bsolvency\b/i,
  /\bguarantee[ds]?\b/i,
  /\btamper[- ]proof\b/i,
  /\bfully backed\b/i,
  /\bprovably safe\b/i,
];

export class ForbiddenClaimError extends Error {
  override readonly name = 'ForbiddenClaimError';
  readonly matched: string;
  constructor(matched: string) {
    super(`refusing to emit a notification containing the claim ${JSON.stringify(matched)}`);
    this.matched = matched;
  }
}

export const assertBoundedLanguage = (text: string): void => {
  for (const rx of FORBIDDEN_CLAIMS) {
    const m = rx.exec(text);
    if (m !== null) throw new ForbiddenClaimError(m[0]);
  }
};

/** Machine reason codes. Anything else is dropped rather than forwarded. */
const REASON_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,126}$/i;

export class UnsanitizableAlertError extends Error {
  override readonly name = 'UnsanitizableAlertError';
}

/**
 * Build the outbound payload.
 *
 * Constructed from an allowlist of fields, never by deleting fields from a
 * larger object: a copy-then-delete sanitizer leaks whatever field is added
 * upstream next month, which is how this class of bug always happens.
 */
export const sanitize = (ctx: AlertContext): NotificationPayload => {
  if (!ID.test(ctx.deploymentId) || !ID.test(ctx.ruleId))
    throw new UnsanitizableAlertError('deployment or rule id has an unexpected shape');
  if (!HEX64.test(ctx.evidenceHash))
    throw new UnsanitizableAlertError('evidence hash is not a sha256 digest');

  const summary = `${STATE_PREFIX[ctx.state]}: ${SUMMARY[ctx.severity]}`;
  const payload: NotificationPayload = {
    schema: NOTIFICATION_SCHEMA,
    dedupKey: ctx.dedupKey,
    deploymentId: ctx.deploymentId,
    ruleId: ctx.ruleId,
    state: ctx.state,
    severity: ctx.severity,
    occurrences: ctx.occurrences,
    reasonCodes: ctx.reasonCodes.filter((c) => REASON_CODE.test(c)),
    summary,
    freshness: { observedAt: ctx.observedAt, expiresAt: ctx.expiresAt, fresh: ctx.fresh },
    evidence: {
      contentHash: ctx.evidenceHash,
      schemaVersion: ctx.evidenceSchemaVersion,
      retrievePath: `/v1/alerts/${ctx.dedupKey}`,
    },
  };

  // Last gate before the payload leaves the process. A finding here means the
  // caller built the context wrong; failing is correct, scrubbing is not.
  const serialised = JSON.stringify(payload);
  assertSecretFree(serialised);
  assertBoundedLanguage(serialised);
  return payload;
};

/**
 * Decode a stored payload back into a notification.
 *
 * The outbox column is `jsonb`, so what comes back is `unknown` and must be
 * checked, not cast. A row written by an older build with a different schema
 * version is refused rather than forwarded to a notifier half-formed.
 */
export const decodeNotification = (value: unknown): NotificationPayload | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v['schema'] !== NOTIFICATION_SCHEMA) return null;
  const evidence = v['evidence'];
  const freshness = v['freshness'];
  if (typeof evidence !== 'object' || evidence === null) return null;
  if (typeof freshness !== 'object' || freshness === null) return null;
  const e = evidence as Record<string, unknown>;
  const f = freshness as Record<string, unknown>;
  const codes = v['reasonCodes'];
  if (
    typeof v['dedupKey'] !== 'string' ||
    typeof v['deploymentId'] !== 'string' ||
    typeof v['ruleId'] !== 'string' ||
    typeof v['state'] !== 'string' ||
    typeof v['severity'] !== 'string' ||
    typeof v['summary'] !== 'string' ||
    typeof v['occurrences'] !== 'number' ||
    !Array.isArray(codes) ||
    !codes.every((c: unknown) => typeof c === 'string') ||
    typeof e['contentHash'] !== 'string' ||
    typeof e['schemaVersion'] !== 'string' ||
    typeof e['retrievePath'] !== 'string' ||
    typeof f['observedAt'] !== 'string' ||
    typeof f['expiresAt'] !== 'string' ||
    typeof f['fresh'] !== 'boolean'
  ) {
    return null;
  }
  return {
    schema: NOTIFICATION_SCHEMA,
    dedupKey: v['dedupKey'],
    deploymentId: v['deploymentId'],
    ruleId: v['ruleId'],
    state: v['state'] as NotificationPayload['state'],
    severity: v['severity'] as NotificationPayload['severity'],
    occurrences: v['occurrences'],
    reasonCodes: codes as readonly string[],
    summary: v['summary'],
    freshness: { observedAt: f['observedAt'], expiresAt: f['expiresAt'], fresh: f['fresh'] },
    evidence: {
      contentHash: e['contentHash'],
      schemaVersion: e['schemaVersion'],
      retrievePath: e['retrievePath'],
    },
  };
};
