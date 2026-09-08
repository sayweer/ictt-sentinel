import { DATA_STATUSES, PROTOCOL_STATUSES, type DeploymentStatus } from '../api/contract.js';
import type { ApiFailure } from '../api/client.js';
import type { Tone } from './verdict.js';

/**
 * Screen state.
 *
 * Every screen in this console is one of these, and each one is designed rather
 * than left to fall out of a null check. The two that get skipped in most
 * dashboards are the ones that matter most here:
 *
 *   `loading` carries a deadline. A spinner that spins forever is a screen that
 *   tells an operator nothing while implying everything is fine.
 *
 *   `not-configured` is distinct from `empty`. "You have not connected anything"
 *   and "you are connected and there is nothing to report" look identical in a
 *   naive UI and mean opposite things.
 */

export const CONDITIONS = [
  'healthy-fresh',
  'warn',
  'critical',
  'unknown',
  'stale',
  'split-brain',
  'incomplete-census',
  'unsupported-adapter',
] as const;
export type Condition = (typeof CONDITIONS)[number];

export interface ConditionCopy {
  readonly tone: Tone;
  readonly title: string;
  /** Why the screen is in this state. */
  readonly reason: string;
  /** What to do next. Always present: a dead end is a bug. */
  readonly remedy: string;
}

const COPY: Readonly<Record<Condition, ConditionCopy>> = {
  'healthy-fresh': {
    tone: 'ok',
    title: 'Reconciled at the pinned blocks',
    reason: 'Every required check completed on fresh evidence and none of them failed.',
    remedy: 'Nothing to do. Open the evidence bundle if you need the pinned blocks.',
  },
  warn: {
    tone: 'warn',
    title: 'Policy or liveness deviation',
    reason:
      'Something deviates from policy or is slower than expected. No accounting breach was observed.',
    remedy: 'Open the reason codes. A deviation is not shown under a coverage headline.',
  },
  critical: {
    tone: 'critical',
    title: 'Breach observed with sufficient evidence',
    reason: 'A deterministic accounting rule failed against evidence pinned to specific blocks.',
    remedy:
      'Follow the runbook for the failing rule. Start from the evidence bundle, not from here.',
  },
  unknown: {
    tone: 'unknown',
    title: 'Not established',
    reason: 'A required check could not be completed, so no verdict can be given.',
    remedy: 'Open the reason codes to see which check is blind. Do not read this as healthy.',
  },
  stale: {
    tone: 'unknown',
    title: 'Stale evaluation',
    reason:
      'No fresh evaluation arrived within the freshness window, so the previous result was degraded.',
    remedy:
      'Check that the local agent is running and can reach its providers. This describes the past.',
  },
  'split-brain': {
    tone: 'critical',
    title: 'Independent witnesses disagree',
    reason:
      'Two independent provider groups reported different history for the same pinned height.',
    remedy:
      'Treat this as a data fault, not a tiebreak. Identify the diverging provider before trusting either answer.',
  },
  'incomplete-census': {
    tone: 'unknown',
    title: 'Remote census incomplete',
    reason:
      'At least one registered remote could not be observed, so the liability side is not complete.',
    remedy:
      'Missing remotes are listed, never netted to zero. Restore access to that chain, then re-evaluate.',
  },
  'unsupported-adapter': {
    tone: 'unknown',
    title: 'Deployment shape not interpreted by this build',
    reason:
      'The observed contracts do not match a source-locked shape this build knows how to read.',
    remedy:
      'An unsupported shape is reported as unknown, never as passing. Check the fingerprint panel.',
  },
};

export const conditionCopy = (condition: Condition): ConditionCopy => COPY[condition];

/** Only one condition is healthy. Every other value is explicitly not green. */
export const isHealthyCondition = (condition: Condition): boolean => condition === 'healthy-fresh';

export interface ConditionInput {
  readonly status: DeploymentStatus;
  /** From the bundle when the operator shared it; unknown otherwise. */
  readonly claimMode?: string | undefined;
  readonly coverage?: string | undefined;
  readonly censusComplete?: boolean | undefined;
}

/**
 * Derive the condition, fail-closed.
 *
 * Order is precedence, and precedence is the whole design. A proven breach
 * outranks everything. A data fault outranks an inability to interpret. Anything
 * unresolved outranks a deviation. Only the last branch is green, and it is
 * reachable only when nothing else matched.
 */
export const deriveCondition = (input: ConditionInput): Condition => {
  const { status } = input;
  // Fail closed before anything else. The decoder rejects values outside the
  // contract, but a build talking to a newer API would otherwise fall through
  // the chain below and reach the healthy branch by elimination. A status this
  // build does not understand is a blind spot, not a pass.
  if (
    !(PROTOCOL_STATUSES as readonly string[]).includes(status.currentProtocolStatus) ||
    !(DATA_STATUSES as readonly string[]).includes(status.currentDataStatus)
  ) {
    return 'unknown';
  }
  if (status.currentProtocolStatus === 'CRITICAL') return 'critical';
  if (status.currentDataStatus === 'DIVERGENT') return 'split-brain';
  if (input.claimMode === 'UNSUPPORTED') return 'unsupported-adapter';
  if (status.stale || status.currentDataStatus === 'STALE') return 'stale';
  if (input.censusComplete === false || input.coverage === 'PARTIAL') return 'incomplete-census';
  if (status.currentProtocolStatus === 'UNKNOWN') return 'unknown';
  if (status.currentDataStatus === 'PARTIAL' || status.currentDataStatus === 'UNKNOWN') {
    return 'unknown';
  }
  if (status.currentProtocolStatus === 'WARN') return 'warn';
  // Only `OK` + `COMPLETE` survives every branch above, and the guard at the top
  // is what makes that true at runtime rather than only in the type system.
  return 'healthy-fresh';
};

export interface LoadingState {
  readonly kind: 'loading';
  /** True once the request has outlived the patience budget. */
  readonly slow: boolean;
  readonly notice: string;
  readonly remedy: string | null;
}

export interface NotConfiguredState {
  readonly kind: 'not-configured';
  readonly notice: string;
  readonly remedy: string;
}

export interface EmptyState {
  readonly kind: 'empty';
  readonly notice: string;
  readonly remedy: string;
}

export interface FailedState {
  readonly kind: 'failed';
  readonly notice: string;
  readonly remedy: string;
  readonly failureKind: string;
}

export interface ReadyState<T> {
  readonly kind: 'ready';
  readonly data: T;
}

export type ScreenState<T> =
  LoadingState | NotConfiguredState | EmptyState | FailedState | ReadyState<T>;

/** How long a request may run before the screen admits something is wrong. */
export const SLOW_AFTER_MS = 4_000;

export const loading = (elapsedMs: number): LoadingState =>
  elapsedMs < SLOW_AFTER_MS
    ? { kind: 'loading', slow: false, notice: 'Loading from the hosted API…', remedy: null }
    : {
        kind: 'loading',
        slow: true,
        notice: 'The hosted API has not answered yet.',
        remedy:
          'The hosted plane is optional. Local evaluation, evidence and alerting continue without it.',
      };

export const notConfigured = (notice: string, remedy: string): NotConfiguredState => ({
  kind: 'not-configured',
  notice,
  remedy,
});

export const empty = (notice: string, remedy: string): EmptyState => ({
  kind: 'empty',
  notice,
  remedy,
});

export const failed = (failure: ApiFailure): FailedState => ({
  kind: 'failed',
  notice: failure.message,
  remedy: failure.remedy,
  failureKind: failure.kind,
});

export const ready = <T>(data: T): ReadyState<T> => ({ kind: 'ready', data });
