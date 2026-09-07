/**
 * Typed data-quality reasons.
 *
 * Every way a replay can fail to produce trustworthy history gets its own code.
 * A single generic "fetch failed" would let silent truncation - the dangerous
 * one, because it looks like a successful empty answer - hide behind a retry.
 *
 * None of these is a verdict. They are the evidence a verdict is built from, and
 * every one of them blocks checkpoint advancement (docs/INVARIANTS.md 2).
 */

export const REPLAY_REASONS = [
  /** Fewer logs than the provider's own bounds imply; the answer was cut short. */
  'SILENT_TRUNCATION',
  /** A height inside the range produced no block at all. */
  'MISSING_BLOCK',
  /** A block's log set is missing an index the surrounding indices imply. */
  'MISSING_LOG',
  /** The endpoint cannot serve this depth: its history was pruned. */
  'PRUNED_HISTORY',
  /** Zero logs returned, and nothing distinguishes "none exist" from "not served". */
  'EMPTY_RESPONSE_AMBIGUITY',
  /** Independent provider groups disagree on the digest or the block hashes. */
  'PROVIDER_DIVERGENCE',
  /** Too few independent provider groups answered to satisfy the policy. */
  'INSUFFICIENT_WITNESSES',
  /** The retry budget for a range was spent without a usable answer. */
  'RETRY_BUDGET_EXHAUSTED',
  /** A range could not be split any further and still failed. */
  'RANGE_INDIVISIBLE',
  /** The newest successful collection is older than its freshness TTL. */
  'STALE_COLLECTION',
  /** An archive witness was needed but none is declared independent in policy. */
  'ARCHIVE_FALLBACK_UNAVAILABLE',
  /** A registered remote has no RPC, no start block, or no reachable history. */
  'REMOTE_HISTORY_UNAVAILABLE',
  /** A candidate (unfinalized) block appeared in a canonical-path answer. */
  'NONCANONICAL_BLOCK_REJECTED',
] as const;

export type ReplayReason = (typeof REPLAY_REASONS)[number];

export interface ReasonMetadata {
  /** Short operator-facing statement. Never phrased as an economic finding. */
  readonly summary: string;
  /** Runbook anchor an on-call engineer can open directly. */
  readonly runbook: string;
  /**
   * Whether more attempts could plausibly help. `false` means the answer is
   * structural and retrying is just noise.
   */
  readonly retryable: boolean;
}

/**
 * Reason metadata.
 *
 * The language here is deliberately about *observation coverage*, never about
 * collateral: a gap in history is not evidence of an economic problem, and
 * reporting it as one is the failure mode docs/INVARIANTS.md 1 forbids.
 */
export const REASON_METADATA: Readonly<Record<ReplayReason, ReasonMetadata>> = {
  SILENT_TRUNCATION: {
    summary: 'Provider returned a short answer without signalling a limit',
    runbook: 'docs/RUNBOOK.md#replay-silent-truncation',
    retryable: true,
  },
  MISSING_BLOCK: {
    summary: 'A height inside the planned range returned no block',
    runbook: 'docs/RUNBOOK.md#replay-missing-block',
    retryable: true,
  },
  MISSING_LOG: {
    summary: 'Log index sequence has a hole inside a block',
    runbook: 'docs/RUNBOOK.md#replay-missing-log',
    retryable: true,
  },
  PRUNED_HISTORY: {
    summary: 'Endpoint cannot serve this depth; history is pruned',
    runbook: 'docs/RUNBOOK.md#replay-pruned-history',
    retryable: false,
  },
  EMPTY_RESPONSE_AMBIGUITY: {
    summary: 'Empty result is indistinguishable from unserved range',
    runbook: 'docs/RUNBOOK.md#replay-empty-ambiguity',
    retryable: true,
  },
  PROVIDER_DIVERGENCE: {
    summary: 'Independent provider groups disagree on range content',
    runbook: 'docs/RUNBOOK.md#replay-divergence',
    retryable: false,
  },
  INSUFFICIENT_WITNESSES: {
    summary: 'Fewer independent provider groups than the policy requires',
    runbook: 'docs/RUNBOOK.md#replay-insufficient-witnesses',
    // Structural: neither another attempt nor a narrower range can conjure an
    // extra independent provider group. Retrying would only delay the answer.
    retryable: false,
  },
  RETRY_BUDGET_EXHAUSTED: {
    summary: 'Range retry budget spent without a usable answer',
    runbook: 'docs/RUNBOOK.md#replay-retry-budget',
    retryable: false,
  },
  RANGE_INDIVISIBLE: {
    summary: 'A single-block range still failed; splitting cannot help',
    runbook: 'docs/RUNBOOK.md#replay-indivisible',
    retryable: false,
  },
  STALE_COLLECTION: {
    summary: 'Newest successful collection is past its freshness TTL',
    runbook: 'docs/RUNBOOK.md#replay-stale',
    retryable: true,
  },
  ARCHIVE_FALLBACK_UNAVAILABLE: {
    summary: 'No independent archive witness is declared in policy',
    runbook: 'docs/RUNBOOK.md#replay-archive-fallback',
    retryable: false,
  },
  REMOTE_HISTORY_UNAVAILABLE: {
    summary: 'Registered remote has no reachable start block or history',
    runbook: 'docs/RUNBOOK.md#replay-remote-history',
    retryable: false,
  },
  NONCANONICAL_BLOCK_REJECTED: {
    summary: 'Provider returned a candidate block on the canonical truth path',
    runbook: 'docs/RUNBOOK.md#replay-noncanonical-block',
    retryable: false,
  },
};

export const isRetryable = (reason: ReplayReason): boolean => REASON_METADATA[reason].retryable;
