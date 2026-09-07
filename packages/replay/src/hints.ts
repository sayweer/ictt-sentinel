import { createHash } from 'node:crypto';

/**
 * Priority hints from webhooks and external Metrics/Data APIs.
 *
 * A hint is a *speed* signal and nothing else. It may suggest that a range is
 * worth replaying sooner; it can never become a fact, a verdict, or a reason to
 * move a checkpoint (docs/ARCHITECTURE.md 3: webhook hüküm gücü = hiçbiri).
 *
 * The separation is enforced three ways, and the type below is only the first:
 *   1. `PriorityHint` shares no field shape with an observation - it carries no
 *      logs, no block hash and no digest, so there is nothing to promote.
 *   2. Hints live in their own table with their own grant.
 *   3. The engine reads hints only to order work it was already going to do.
 */

export interface PriorityHint {
  readonly hintId: string;
  readonly deploymentId: string;
  readonly chainKey: string;
  /** A height the source claims is interesting. Never trusted as a fact. */
  readonly suggestedBlockNumber: bigint;
  readonly source: HintSource;
  /** Stable across redeliveries of the same upstream event. */
  readonly dedupKey: string;
  readonly receivedAt: Date;
}

export const HINT_SOURCES = ['webhook', 'metrics-api', 'data-api'] as const;
export type HintSource = (typeof HINT_SOURCES)[number];

export interface HintQueuePolicy {
  /** Hard cap. A flooded queue drops the newest rather than growing without end. */
  readonly maxDepth: number;
}

export type HintAdmission =
  | { readonly kind: 'accepted'; readonly hint: PriorityHint }
  | { readonly kind: 'duplicate'; readonly dedupKey: string }
  | { readonly kind: 'rejected'; readonly reason: 'queue-full' };

/**
 * Deterministic hint identity.
 *
 * Derived from the source and its own event key, so a redelivered webhook maps
 * to the same row and is dropped instead of queueing the same work twice.
 */
export const hintId = (source: HintSource, dedupKey: string): string =>
  createHash('sha256').update(`${source}|${dedupKey}`).digest('hex');

/**
 * Admit a hint into a bounded queue.
 *
 * Pure, so the replay-protection rule is testable without a database: the same
 * dedup key is admitted once and only once, and depth is capped.
 */
export const admitHint = (
  hint: PriorityHint,
  existingDedupKeys: ReadonlySet<string>,
  depth: number,
  policy: HintQueuePolicy,
): HintAdmission => {
  if (existingDedupKeys.has(hint.dedupKey)) {
    return { kind: 'duplicate', dedupKey: hint.dedupKey };
  }
  if (depth >= policy.maxDepth) {
    // Bounded by construction. An unbounded hint queue is a denial-of-service
    // surface reachable by anyone who can post a webhook.
    return { kind: 'rejected', reason: 'queue-full' };
  }
  return { kind: 'accepted', hint };
};

/**
 * Reorder planned work using hints.
 *
 * This is the ONLY influence a hint has. Note what it cannot do: the returned
 * list is a permutation of the input, so a hint can neither add a range that the
 * accepted-head plan did not contain nor remove one that it did. Replay coverage
 * is identical with and without hints; only the order changes.
 */
export const prioritise = <T extends { readonly fromBlock: bigint; readonly toBlock: bigint }>(
  planned: readonly T[],
  hints: readonly PriorityHint[],
): readonly T[] => {
  const hinted = new Set(hints.map((h) => h.suggestedBlockNumber));
  const score = (r: T): number =>
    [...hinted].some((h) => h >= r.fromBlock && h <= r.toBlock) ? 0 : 1;
  return [...planned].sort((a, b) => {
    const d = score(a) - score(b);
    if (d !== 0) return d;
    // Stable within a tier: ascending height keeps replay deterministic.
    return a.fromBlock < b.fromBlock ? -1 : a.fromBlock > b.fromBlock ? 1 : 0;
  });
};
