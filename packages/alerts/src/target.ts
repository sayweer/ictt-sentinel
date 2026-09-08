/**
 * Notification targets and the SSRF boundary in front of them.
 *
 * An alert target is operator-supplied and this process will POST to it on a
 * schedule with no human in the loop. That is an SSRF primitive unless the URL
 * is checked first, so it is checked here, once, and nothing in this package
 * sends anywhere else (docs/SECURITY.md).
 *
 * A target holds the env variable NAME of its URL, never the URL itself. The
 * value is resolved at send time by the application and never stored, logged or
 * put in a payload (CLAUDE.md 3).
 */

export const TARGET_KINDS = ['slack', 'pagerduty', 'generic-webhook'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export interface AlertTarget {
  /** Stable id used in metrics, deliveries and logs. Never a URL. */
  readonly targetId: string;
  readonly kind: TargetKind;
  /** Env variable name holding the destination URL. */
  readonly secretRef: string;
  /** Minimum severity this target receives. */
  readonly minSeverity: 'WARN' | 'UNKNOWN' | 'CRITICAL';
}

/** Same list as the RPC transport guard. Kept local: alerts depends on no adapter. */
const PRIVATE_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local, including the cloud metadata endpoint
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i, // unique local IPv6
  /^\[?fe80:/i,
  /\.local$/i,
  /^metadata\./i,
];

export interface TargetCheck {
  readonly ok: boolean;
  /** Never contains the URL: a rejection reason ends up in a log. */
  readonly reason?: string;
}

const reject = (reason: string): TargetCheck => ({ ok: false, reason });

/**
 * Validate a resolved target URL before anything is sent to it.
 *
 * Fail-closed on every branch. A target that cannot be validated is not
 * attempted, and a notifier that is not attempted is reported as an undelivered
 * alert rather than silently dropped.
 */
export const checkTargetUrl = (raw: string): TargetCheck => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject('target is not a valid URL');
  }
  if (url.protocol !== 'https:') return reject('target must use https');
  if (url.username !== '' || url.password !== '')
    return reject('credentials must not be embedded in the target URL');
  if (PRIVATE_PATTERNS.some((rx) => rx.test(url.hostname)))
    return reject('target resolves to a private, link-local or metadata host');
  // A non-default port on an operator-supplied URL is how an internal service
  // gets reached through a public hostname; there is no legitimate need here.
  if (url.port !== '' && url.port !== '443')
    return reject('target must use the default https port');
  return { ok: true };
};

/** Whether a verdict clears this target's threshold. */
const RANK: Readonly<Record<string, number>> = { OK: 0, WARN: 1, UNKNOWN: 2, CRITICAL: 3 };

export const meetsThreshold = (target: AlertTarget, verdict: string): boolean =>
  (RANK[verdict] ?? -1) >= (RANK[target.minSeverity] ?? 99);
