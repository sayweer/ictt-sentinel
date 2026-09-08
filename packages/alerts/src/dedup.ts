import { createHash } from 'node:crypto';
import type { Verdict } from '@ictt-sentinel/domain';

/**
 * Deterministic alert identity.
 *
 * The key is derived from what the alert IS, never from when it fired or which
 * process produced it. Two agents evaluating the same evidence must land on the
 * same key, or a restart turns one incident into two and an on-call engineer
 * gets paged twice for the same thing.
 *
 * Components, all four required:
 *
 *   deployment          which deployment this is about
 *   rule + reason       what was found
 *   verdict transition  the change, not the state - OK->CRITICAL and
 *                       WARN->CRITICAL are different events
 *   evidence digest     the exact evidence behind it, so re-evaluating the same
 *                       blocks dedups and NEW evidence does not
 */

export interface AlertIdentity {
  readonly deploymentId: string;
  readonly ruleId: string;
  readonly reasonCode: string;
  readonly from: Verdict | 'NONE';
  readonly to: Verdict;
  /** Content hash of the evidence bundle this alert rests on. */
  readonly evidenceDigest: string;
}

const DOMAIN = 'ictt-sentinel/alert/v1';

/** Stable across processes and restarts: no clock, no randomness, no pid. */
export const dedupKey = (id: AlertIdentity): string =>
  createHash('sha256')
    .update(DOMAIN)
    .update('\n')
    .update(
      [id.deploymentId, id.ruleId, id.reasonCode, `${id.from}->${id.to}`, id.evidenceDigest].join(
        '|',
      ),
    )
    .digest('hex');

/**
 * The incident this notification belongs to.
 *
 * Coarser than the dedup key on purpose. `dedupKey` answers "have we already
 * paged exactly this"; `incidentKey` answers "is there an open incident this
 * belongs to". Collapsing the two would either page on every re-evaluation or
 * never page again after the first one, and an acknowledgement or a recovery
 * needs the coarse grouping to have anything to act on.
 */
export const incidentKey = (
  id: Pick<AlertIdentity, 'deploymentId' | 'ruleId' | 'reasonCode'>,
): string =>
  createHash('sha256')
    .update(`${DOMAIN}/incident`)
    .update('\n')
    .update([id.deploymentId, id.ruleId, id.reasonCode].join('|'))
    .digest('hex');

/**
 * Whether a verdict change is worth alerting on at all.
 *
 * Improving is a recovery, not an alert; unchanged is a repeat. Only a
 * transition to a worse state opens something new.
 */
const SEVERITY: Readonly<Record<Verdict | 'NONE', number>> = {
  NONE: -1,
  OK: 0,
  WARN: 1,
  UNKNOWN: 2,
  CRITICAL: 3,
};

export const isEscalation = (from: Verdict | 'NONE', to: Verdict): boolean =>
  SEVERITY[to] > SEVERITY[from];

export const isRecovery = (from: Verdict | 'NONE', to: Verdict): boolean =>
  from !== 'NONE' && SEVERITY[to] < SEVERITY[from] && to === 'OK';
