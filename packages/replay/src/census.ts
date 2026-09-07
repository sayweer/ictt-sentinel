import type { ReplayReason } from './reasons.js';

/**
 * Remote census from `RemoteRegistered` history.
 *
 * Two rules dominate this file:
 *
 *   1. **Scope.** The census is the complete `RemoteRegistered` history of ONE
 *      TokenHome, from its trustworthy deployment/initialization block to the
 *      agreed head. It is never "every ICTT on Avalanche", and the mapping is
 *      not assumed enumerable: without a complete history replay there is no
 *      census, only a partial list.
 *
 *   2. **Trust.** A permissionlessly discovered or self-registered remote is a
 *      *candidate*, never an approved member. It surfaces as manifest drift for
 *      an operator to approve; it is never added silently (docs/DATA_MODEL.md 3.3).
 */

export interface RegisteredRemoteEvent {
  readonly remoteBlockchainId: string;
  readonly remoteAddress: string;
  readonly registeredAtBlock: bigint;
  readonly registeredAtBlockHash: string;
}

export interface ApprovedRemote {
  readonly remoteBlockchainId: string;
  readonly remoteAddress: string;
}

export interface CensusInput {
  /** TokenHome deployment/initialization block from the manifest. */
  readonly homeStartBlock: bigint;
  /** Agreed accepted head the history was replayed to. */
  readonly agreedHead: bigint;
  /** Ranges actually committed with quorum, expressed as covered heights. */
  readonly historyFullyReplayed: boolean;
  readonly observed: readonly RegisteredRemoteEvent[];
  /** Remotes the operator approved in the manifest. */
  readonly approved: readonly ApprovedRemote[];
}

export interface RemoteCandidate {
  readonly remoteBlockchainId: string;
  readonly remoteAddress: string;
  readonly registeredAtBlock: bigint;
  readonly registeredAtBlockHash: string;
  /** Always `candidate`. There is no code path that emits `trusted` here. */
  readonly trust: 'candidate';
}

export interface CrossCheckTask {
  readonly remoteBlockchainId: string;
  readonly remoteAddress: string;
  /**
   * What must be verified on the remote side before this remote could ever be
   * approved: that it names THIS home, on the expected chain and address, with a
   * recognised code fingerprint.
   */
  readonly checks: readonly [
    'home-blockchain-id-matches',
    'home-address-matches',
    'remote-code-fingerprint-recognised',
  ];
}

export interface CensusResult {
  /** Observed but not approved. Reported as drift, never auto-trusted. */
  readonly candidates: readonly RemoteCandidate[];
  /** Approved in the manifest but never seen in history. Also drift. */
  readonly missingFromHistory: readonly ApprovedRemote[];
  /** One mutual-verification task per observed remote. */
  readonly crossChecks: readonly CrossCheckTask[];
  /**
   * `false` whenever the census cannot be claimed complete. A partial history
   * makes the *global* coverage claim UNKNOWN, not merely incomplete.
   */
  readonly complete: boolean;
  readonly reasons: readonly ReplayReason[];
}

const keyOf = (r: { remoteBlockchainId: string; remoteAddress: string }): string =>
  `${r.remoteBlockchainId}|${r.remoteAddress}`;

/**
 * Build the census.
 *
 * When the history was not fully replayed the observed set is still reported -
 * it is real evidence - but `complete` is false and the reason is explicit.
 * Reporting a partial list as the census is the fail-open this guards against.
 */
export const buildCensus = (input: CensusInput): CensusResult => {
  const reasons: ReplayReason[] = [];
  if (!input.historyFullyReplayed) reasons.push('REMOTE_HISTORY_UNAVAILABLE');

  const approvedKeys = new Set(input.approved.map(keyOf));
  const observedKeys = new Set(input.observed.map(keyOf));

  const candidates: RemoteCandidate[] = input.observed
    .filter((o) => !approvedKeys.has(keyOf(o)))
    .map((o) => ({
      remoteBlockchainId: o.remoteBlockchainId,
      remoteAddress: o.remoteAddress,
      registeredAtBlock: o.registeredAtBlock,
      registeredAtBlockHash: o.registeredAtBlockHash,
      trust: 'candidate',
    }));

  const missingFromHistory = input.approved.filter((a) => !observedKeys.has(keyOf(a)));

  const crossChecks: CrossCheckTask[] = input.observed.map((o) => ({
    remoteBlockchainId: o.remoteBlockchainId,
    remoteAddress: o.remoteAddress,
    checks: [
      'home-blockchain-id-matches',
      'home-address-matches',
      'remote-code-fingerprint-recognised',
    ],
  }));

  return {
    candidates,
    missingFromHistory,
    crossChecks,
    complete: input.historyFullyReplayed,
    reasons,
  };
};

/**
 * Coverage completeness across the census.
 *
 * A single remote whose RPC, start block or history is unavailable makes the
 * GLOBAL claim unknown. Coverage is a statement about the whole set; one
 * unreadable member is enough to withdraw it.
 */
export const globalCoverageKnown = (
  census: CensusResult,
  remotesWithReachableHistory: ReadonlySet<string>,
): boolean => {
  if (!census.complete) return false;
  return census.crossChecks.every((c) =>
    remotesWithReachableHistory.has(`${c.remoteBlockchainId}|${c.remoteAddress}`),
  );
};
