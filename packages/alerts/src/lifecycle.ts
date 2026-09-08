import type { Verdict } from '@ictt-sentinel/domain';
import { type AlertIdentity, dedupKey, isEscalation, isRecovery } from './dedup.js';

/**
 * Alert lifecycle.
 *
 * A pure state machine over an unordered-safe fold, driven by observations and
 * an injected clock. `acknowledged` is a HOSTED OPERATIONAL state and nothing
 * more: it silences paging, it does not touch a chain, it does not change a
 * verdict, and it does not close an alert that is still breaching.
 */

export const ALERT_STATES = [
  /** Opened by the first observation of this identity. */
  'first_seen',
  /** Seen again with the same evidence. Counted, not re-paged. */
  'repeated',
  /** The verdict got worse while this alert was open. */
  'escalated',
  /** A human muted paging. Operational only; the breach may still be live. */
  'acknowledged',
  /** The underlying condition returned to OK. */
  'recovered',
] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export interface AlertRecord {
  readonly dedupKey: string;
  readonly identity: AlertIdentity;
  readonly state: AlertState;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  /** How many observations folded into this alert, including the first. */
  readonly occurrences: number;
  readonly currentVerdict: Verdict;
  /** Set when a human acknowledged it. Never set by the system itself. */
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: Date | null;
  readonly recoveredAt: Date | null;
}

export interface Observation {
  readonly identity: AlertIdentity;
  readonly observedAt: Date;
}

/** Open a new alert. Only an escalation opens one. */
export const open = (observation: Observation): AlertRecord => ({
  dedupKey: dedupKey(observation.identity),
  identity: observation.identity,
  state: 'first_seen',
  firstSeenAt: observation.observedAt,
  lastSeenAt: observation.observedAt,
  occurrences: 1,
  currentVerdict: observation.identity.to,
  acknowledgedBy: null,
  acknowledgedAt: null,
  recoveredAt: null,
});

/**
 * Fold an observation into an existing alert.
 *
 * Idempotent on the dedup key: the same evidence observed twice increments a
 * counter and moves `lastSeenAt`, it does not create a second alert and does not
 * re-notify. That is the whole point of the key.
 */
export const observe = (existing: AlertRecord, observation: Observation): AlertRecord => {
  const worse = isEscalation(existing.currentVerdict, observation.identity.to);
  return {
    ...existing,
    // A repeat never rewinds an escalation, and an acknowledgement survives a
    // repeat: silencing must not be undone by the next scan.
    state: worse ? 'escalated' : existing.state === 'first_seen' ? 'repeated' : existing.state,
    lastSeenAt: observation.observedAt,
    occurrences: existing.occurrences + 1,
    currentVerdict: worse ? observation.identity.to : existing.currentVerdict,
  };
};

/**
 * Acknowledge. Operational state only.
 *
 * Deliberately does NOT change `currentVerdict`: a muted alarm and a fixed
 * deployment are different things, and conflating them is how a live breach
 * disappears from a dashboard.
 */
export const acknowledge = (existing: AlertRecord, by: string, at: Date): AlertRecord => ({
  ...existing,
  state: existing.state === 'recovered' ? 'recovered' : 'acknowledged',
  acknowledgedBy: by,
  acknowledgedAt: at,
});

/** Close on a genuine return to OK. */
export const recover = (existing: AlertRecord, to: Verdict, at: Date): AlertRecord | null => {
  if (!isRecovery(existing.currentVerdict, to)) return null;
  return {
    ...existing,
    state: 'recovered',
    currentVerdict: to,
    lastSeenAt: at,
    recoveredAt: at,
  };
};

/** Whether this transition should page. Repeats and acknowledged alerts do not. */
export const shouldNotify = (before: AlertRecord | null, after: AlertRecord): boolean => {
  if (after.state === 'acknowledged') return false;
  if (before === null) return after.state === 'first_seen';
  if (after.state === 'recovered' && before.state !== 'recovered') return true;
  return after.state === 'escalated' && before.state !== 'escalated';
};
