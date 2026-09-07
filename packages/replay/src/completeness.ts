import type { Verdict } from '@ictt-sentinel/domain';
import type { BlockRange } from './plan.js';
import { findRangeGaps } from './range.js';
import type { ReplayReason } from './reasons.js';

/**
 * Replay completeness and freshness.
 *
 * The rule this file exists for: a previous success must not stay green while
 * new collections are failing. Coverage decays with time, so `OK` carries a TTL
 * and expires into `UNKNOWN` on its own (docs/adr/0003-fail-closed-verdicts.md).
 *
 * Pure. `now` is injected, never read from the clock, so the state machine is
 * testable and cannot flake.
 */

export const REPLAY_STATUSES = [
  'pending',
  'complete',
  'gap',
  'stale',
  'divergent',
  'blocked',
] as const;
export type ReplayStatus = (typeof REPLAY_STATUSES)[number];

export interface CompletenessInput {
  /** The window that must be covered: trustworthy start .. agreed accepted head. */
  readonly window: BlockRange;
  /** Ranges committed with quorum. Anything else does not count as covered. */
  readonly committed: readonly BlockRange[];
  /** When the newest committed range was collected. */
  readonly lastSuccessAt: Date | null;
  /** How long a successful collection stays authoritative. */
  readonly freshnessTtlMs: number;
  /** Reasons raised during the current attempt, if any. */
  readonly openReasons: readonly ReplayReason[];
  readonly now: Date;
}

export interface CompletenessResult {
  readonly status: ReplayStatus;
  /** How the status is reported upwards. `UNKNOWN` is never softened to `OK`. */
  readonly verdict: Verdict;
  readonly gaps: readonly BlockRange[];
  readonly reasons: readonly ReplayReason[];
  /** Milliseconds since the last success; null when there has never been one. */
  readonly ageMs: number | null;
}

const BLOCKING_REASONS: ReadonlySet<ReplayReason> = new Set([
  'PRUNED_HISTORY',
  'RETRY_BUDGET_EXHAUSTED',
  'RANGE_INDIVISIBLE',
  'ARCHIVE_FALLBACK_UNAVAILABLE',
  'REMOTE_HISTORY_UNAVAILABLE',
  'NONCANONICAL_BLOCK_REJECTED',
  'INSUFFICIENT_WITNESSES',
]);

/**
 * Collapse the evidence into one operator-visible status.
 *
 * Precedence is deliberate and fail-closed. Divergence outranks everything
 * because it means the chain view itself is contested; a gap outranks staleness
 * because missing history is worse than old history; and staleness outranks
 * completeness because "we succeeded once, a long time ago" is not coverage now.
 */
export const assessCompleteness = (input: CompletenessInput): CompletenessResult => {
  const gaps = findRangeGaps(input.committed, input.window);
  const ageMs =
    input.lastSuccessAt === null ? null : input.now.getTime() - input.lastSuccessAt.getTime();

  const divergent = input.openReasons.includes('PROVIDER_DIVERGENCE');
  const blocked = input.openReasons.some((r) => BLOCKING_REASONS.has(r));

  if (divergent) {
    return { status: 'divergent', verdict: 'UNKNOWN', gaps, reasons: input.openReasons, ageMs };
  }
  if (blocked) {
    return { status: 'blocked', verdict: 'UNKNOWN', gaps, reasons: input.openReasons, ageMs };
  }
  if (gaps.length > 0) {
    // Never OK: a hole in history is exactly the thing that must not be green.
    return { status: 'gap', verdict: 'UNKNOWN', gaps, reasons: input.openReasons, ageMs };
  }
  if (input.lastSuccessAt === null || ageMs === null) {
    return { status: 'pending', verdict: 'UNKNOWN', gaps, reasons: input.openReasons, ageMs };
  }
  if (ageMs > input.freshnessTtlMs) {
    // The whole window is covered, but the coverage has expired. A stale OK is
    // the failure this branch exists to prevent.
    return {
      status: 'stale',
      verdict: 'UNKNOWN',
      gaps,
      reasons: [...input.openReasons, 'STALE_COLLECTION'],
      ageMs,
    };
  }
  return { status: 'complete', verdict: 'OK', gaps, reasons: input.openReasons, ageMs };
};

/**
 * A gap counts as closed only when the recovery range was committed in full and
 * with quorum. Partial recovery leaves the gap open, which keeps the status at
 * `gap` rather than quietly returning to `complete`.
 */
export const isGapClosed = (gap: BlockRange, committed: readonly BlockRange[]): boolean =>
  findRangeGaps(committed, gap).length === 0;
