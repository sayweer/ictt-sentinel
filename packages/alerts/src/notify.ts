import type { Verdict } from '@ictt-sentinel/domain';
import { redact } from '@ictt-sentinel/evidence';
import type { NotificationPayload } from './sanitize.js';
import { type AlertTarget, checkTargetUrl, meetsThreshold } from './target.js';

/**
 * Delivery.
 *
 * The load-bearing rule of this file: **a notifier failure never changes a
 * verdict.** A Slack outage is an alerting incident, not evidence that a bridge
 * became healthy. So `deliver` is typed to have no verdict in scope at all, and
 * `dispatch` returns the verdict it was handed by identity - the property is
 * structural, not a promise in a comment.
 *
 * Nothing here retries. One attempt is made and the outcome is reported; the
 * outbox owns retry, backoff and the attempt budget, so a transport that hangs
 * cannot spin inside a scheduler tick.
 */

export type DeliveryOutcome = 'delivered' | 'rejected' | 'error' | 'skipped';

export interface DeliveryReport {
  readonly targetId: string;
  readonly outcome: DeliveryOutcome;
  /** Redacted, bounded, and never the response body. */
  readonly reason: string;
  readonly httpStatus: number | null;
}

export interface NotifierTransport {
  post(
    url: string,
    body: string,
    signal: AbortSignal,
  ): Promise<{ readonly status: number; readonly ok: boolean }>;
}

export interface DeliverOptions {
  readonly target: AlertTarget;
  readonly payload: NotificationPayload;
  /** Resolved from the env by the application. Never stored, never logged. */
  readonly url: string | undefined;
  readonly transport: NotifierTransport;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/** Bounded so an error string cannot become an exfiltration channel. */
const reason = (text: string): string => redact(text).slice(0, 200);

/**
 * Send one notification to one target.
 *
 * Total: every failure path produces a report instead of an exception, because
 * the only caller is a loop that must keep going and must record what happened
 * to each target.
 */
export const deliver = async (options: DeliverOptions): Promise<DeliveryReport> => {
  const { target, payload, url, transport, timeoutMs, signal } = options;
  const base = { targetId: target.targetId, httpStatus: null } as const;

  if (!meetsThreshold(target, payload.severity))
    return { ...base, outcome: 'skipped', reason: 'below target severity threshold' };
  if (url === undefined || url === '')
    return {
      ...base,
      outcome: 'error',
      reason: `target secret ${target.secretRef} is not set`,
    };

  const check = checkTargetUrl(url);
  if (!check.ok) return { ...base, outcome: 'rejected', reason: check.reason ?? 'target refused' };

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await transport.post(
      url,
      JSON.stringify(payload),
      AbortSignal.any([signal, controller.signal]),
    );
    return {
      targetId: target.targetId,
      httpStatus: response.status,
      outcome: response.ok ? 'delivered' : 'rejected',
      reason: response.ok ? 'delivered' : `target returned ${String(response.status)}`,
    };
  } catch (e) {
    return {
      ...base,
      outcome: 'error',
      reason: reason(e instanceof Error ? e.message : 'transport failed'),
    };
  } finally {
    clearTimeout(timer);
  }
};

export interface DispatchResult {
  /** The same value that was passed in. Delivery cannot alter a judgement. */
  readonly verdict: Verdict;
  readonly reports: readonly DeliveryReport[];
  /** True when at least one target refused or failed. Operational, not a verdict. */
  readonly degraded: boolean;
}

/**
 * Notify every target for one alert.
 *
 * The verdict travels through untouched. Delivery failures surface as
 * `degraded`, which the agent exposes as its own health signal - the product
 * being unable to shout is a fault of the product, not of the deployment.
 */
export const dispatch = async (
  verdict: Verdict,
  targets: readonly AlertTarget[],
  resolve: (secretRef: string) => string | undefined,
  options: Omit<DeliverOptions, 'target' | 'url'>,
): Promise<DispatchResult> => {
  const reports: DeliveryReport[] = [];
  for (const target of targets) {
    reports.push(await deliver({ ...options, target, url: resolve(target.secretRef) }));
  }
  return {
    verdict,
    reports,
    degraded: reports.some((r) => r.outcome === 'error' || r.outcome === 'rejected'),
  };
};

/**
 * Default transport.
 *
 * `redirect: 'error'` matters: a 302 from a webhook host is a way to move a POST
 * onto an address the SSRF guard already refused.
 */
export const httpTransport = (fetcher: typeof fetch = fetch): NotifierTransport => ({
  post: async (url, body, signal) => {
    const response = await fetcher(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body,
      signal,
    });
    // The body is never read. Nothing a notifier says back is trusted, and
    // reading it is an unbounded allocation controlled by a third party.
    return { status: response.status, ok: response.ok };
  },
});
