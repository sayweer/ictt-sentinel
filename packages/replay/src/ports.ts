import type { BlockRange } from './plan.js';
import type { RangeObservation } from './range.js';
import type { ReplayReason } from './reasons.js';

/**
 * The narrow read port the engine is allowed to use.
 *
 * Note what is absent: no `request(method, params)`, no transport handle, no
 * endpoint URL, no signer. The engine can ask exactly two questions - "what is
 * the agreed accepted head" and "what logs are in this range" - and nothing
 * else. Widening this interface is how a read-only tool grows a write surface,
 * so it stays closed (CLAUDE.md 3, docs/SECURITY.md).
 */

export type FetchOutcome =
  | { readonly ok: true; readonly observation: RangeObservation }
  | { readonly ok: false; readonly reason: ReplayReason; readonly providerGroup: string };

export interface LogSourcePort {
  /**
   * The head both sides already agree on. Never a single provider's `latest`:
   * comparing two chains' `latest` answers is the error docs/DATA_MODEL.md 2.3
   * makes structurally impossible.
   */
  agreedAcceptedHead(chainKey: string): Promise<bigint>;

  /** Independent provider groups available for this chain, in policy order. */
  providerGroups(chainKey: string): readonly string[];

  /** Widest range this provider group will serve, from its declared capability. */
  maxRangeBlocks(chainKey: string, providerGroup: string): number;

  /** Read one range from one group. Never merges groups; the caller compares them. */
  fetchRange(chainKey: string, providerGroup: string, range: BlockRange): Promise<FetchOutcome>;
}
