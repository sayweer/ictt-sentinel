import type { Verdict } from '@ictt-sentinel/domain';

/**
 * Freshness expiry.
 *
 * The failure this prevents: an agent loses its RPC endpoints, stops producing
 * new evaluations, and a dashboard keeps showing the last OK for hours. A green
 * light that is really "we have not looked since Tuesday" is worse than no light
 * at all, so age is applied to a verdict rather than displayed next to it.
 *
 * Two thresholds from policy (`spec.evidence`):
 *
 *   maxAgeSeconds        beyond this the evaluation is stale and degrades.
 *   expiresAfterSeconds  beyond this it may not be reported at all.
 *
 * Degradation is one-directional. OK and WARN become UNKNOWN because we can no
 * longer say they hold; CRITICAL stays CRITICAL, because age is not evidence
 * that a breach was resolved (docs/adr/0003-fail-closed-verdicts.md).
 */

export const STALE_REASON = 'STALE_EVALUATION' as const;
export const EXPIRED_REASON = 'EVALUATION_EXPIRED' as const;

export interface FreshnessPolicy {
  readonly maxAgeSeconds: number;
  readonly expiresAfterSeconds: number;
}

export interface FreshnessResult {
  readonly verdict: Verdict;
  readonly stale: boolean;
  /** False means: do not surface this evaluation anywhere, at any severity. */
  readonly reportable: boolean;
  readonly ageSeconds: number;
  readonly reasonCodes: readonly string[];
}

export const applyFreshness = (
  verdict: Verdict,
  observedAtMs: number,
  nowMs: number,
  policy: FreshnessPolicy,
): FreshnessResult => {
  // A negative age means the evaluation claims to come from the future, which is
  // a clock fault somewhere. Treat it as maximally stale rather than as fresh.
  const ageSeconds = Math.floor((nowMs - observedAtMs) / 1000);
  const skewed = ageSeconds < 0;
  const expired = skewed || ageSeconds > policy.expiresAfterSeconds;
  const stale = skewed || ageSeconds > policy.maxAgeSeconds;

  if (!stale) {
    return { verdict, stale: false, reportable: true, ageSeconds, reasonCodes: [] };
  }
  const degraded: Verdict = verdict === 'CRITICAL' ? 'CRITICAL' : 'UNKNOWN';
  return {
    verdict: degraded,
    stale: true,
    reportable: !expired,
    ageSeconds,
    reasonCodes: expired ? [STALE_REASON, EXPIRED_REASON] : [STALE_REASON],
  };
};
