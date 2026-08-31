import type { RemoteRegisteredObservation } from './observations.js';

/**
 * Discovery and census.
 *
 * Discovery produces a candidate and a diff. It never writes a baseline: anyone
 * can deploy and register a remote, and the official documentation puts the
 * burden of evaluating it on the operator, so an observed topology is something
 * to review rather than something to trust (docs/PRODUCT.md section 4).
 */

export interface CandidateRemote {
  readonly remoteBlockchainId: string;
  readonly remoteTokenTransferrerAddress: string;
  readonly collateralNeededAtRegistration: bigint;
  readonly remoteTokenDecimals: number;
  readonly firstSeenBlock: bigint;
  readonly firstSeenTxHash: string;
  /**
   * Always false on first sight. A registration event establishes that a remote
   * registered, never that it is trusted.
   */
  readonly trusted: false;
}

export const CENSUS_COMPLETENESS = [
  'complete-from-deployment-block',
  'partial',
  'unknown',
] as const;
export type CensusCompleteness = (typeof CENSUS_COMPLETENESS)[number];

export interface CandidateCensus {
  /** Bounded to one TokenHome's own registration history, never to a chain. */
  readonly tokenHomeAddress: string;
  readonly homeBlockchainId: string;
  readonly fromBlock?: bigint;
  readonly toBlock: bigint;
  readonly completeness: CensusCompleteness;
  readonly remotes: readonly CandidateRemote[];
  readonly reasons: readonly string[];
}

export interface CensusInput {
  readonly tokenHomeAddress: string;
  readonly homeBlockchainId: string;
  /** Deployment block of this TokenHome. Absent means history cannot be bounded. */
  readonly tokenHomeDeploymentBlock?: bigint;
  /** First block actually scanned. */
  readonly scannedFromBlock?: bigint;
  readonly scannedToBlock: bigint;
  /** True when the scan hit a gap it could not fill from an archive endpoint. */
  readonly hadLogGap: boolean;
  readonly registrations: readonly RemoteRegisteredObservation[];
}

/**
 * Build a candidate census from observed registrations.
 *
 * Completeness is claimed only when the scan provably started at or before the
 * TokenHome deployment block and had no gap. Without a trustworthy deployment
 * block there is no lower bound on what was missed, so the census cannot call
 * itself complete however many events it found.
 */
export const buildCandidateCensus = (input: CensusInput): CandidateCensus => {
  const reasons: string[] = [];
  let completeness: CensusCompleteness = 'complete-from-deployment-block';

  if (input.tokenHomeDeploymentBlock === undefined) {
    completeness = 'unknown';
    reasons.push('the TokenHome deployment block is unknown, so no lower bound on history exists');
  } else if (input.scannedFromBlock === undefined) {
    completeness = 'unknown';
    reasons.push('the scan start block is unknown');
  } else if (input.scannedFromBlock > input.tokenHomeDeploymentBlock) {
    completeness = 'partial';
    reasons.push(
      `the scan started at block ${input.scannedFromBlock.toString()}, after the TokenHome was deployed at ` +
        `${input.tokenHomeDeploymentBlock.toString()}; earlier registrations were not observed`,
    );
  }

  if (input.hadLogGap) {
    completeness = completeness === 'unknown' ? 'unknown' : 'partial';
    reasons.push('the log scan had a gap that no archive endpoint filled');
  }

  const seen = new Map<string, CandidateRemote>();
  for (const r of input.registrations) {
    const key = `${r.remoteBlockchainId.toLowerCase()}:${r.remoteTokenTransferrerAddress.toLowerCase()}`;
    // Keep the earliest sighting: registration is once per pair on chain, and a
    // later duplicate would be the interesting anomaly, not a correction.
    const existing = seen.get(key);
    if (existing !== undefined && existing.firstSeenBlock <= r.source.blockNumber) continue;
    seen.set(key, {
      remoteBlockchainId: r.remoteBlockchainId.toLowerCase(),
      remoteTokenTransferrerAddress: r.remoteTokenTransferrerAddress.toLowerCase(),
      collateralNeededAtRegistration: r.collateralNeeded,
      remoteTokenDecimals: r.remoteTokenDecimals,
      firstSeenBlock: r.source.blockNumber,
      firstSeenTxHash: r.source.txHash,
      trusted: false,
    });
  }

  const base: CandidateCensus = {
    tokenHomeAddress: input.tokenHomeAddress.toLowerCase(),
    homeBlockchainId: input.homeBlockchainId.toLowerCase(),
    toBlock: input.scannedToBlock,
    completeness,
    remotes: [...seen.values()].sort((a, b) =>
      a.remoteBlockchainId === b.remoteBlockchainId
        ? a.remoteTokenTransferrerAddress.localeCompare(b.remoteTokenTransferrerAddress)
        : a.remoteBlockchainId.localeCompare(b.remoteBlockchainId),
    ),
    reasons,
  };
  return input.scannedFromBlock === undefined
    ? base
    : { ...base, fromBlock: input.scannedFromBlock };
};

// ------------------------------------------------------------------- diff

/** A remote the operator has already approved, taken from the manifest. */
export interface ApprovedRemote {
  readonly remoteBlockchainId: string;
  readonly remoteTokenTransferrerAddress: string;
  readonly expectedDecimals: number;
}

export const DRIFT_KINDS = [
  'candidate-not-approved',
  'approved-not-observed',
  'decimals-mismatch',
] as const;
export type DriftKind = (typeof DRIFT_KINDS)[number];

export interface DriftEntry {
  readonly kind: DriftKind;
  readonly remoteBlockchainId: string;
  readonly remoteTokenTransferrerAddress: string;
  readonly detail: string;
}

export interface DiscoveryDiff {
  readonly baselineDigest: string;
  readonly censusCompleteness: CensusCompleteness;
  readonly drift: readonly DriftEntry[];
  /**
   * Never true. A diff describes what changed; applying it is a separate,
   * human-approved step, so this type cannot be mistaken for an update.
   */
  readonly mutatesBaseline: false;
}

const key = (b: string, a: string): string => `${b.toLowerCase()}:${a.toLowerCase()}`;

/**
 * Compare a candidate census against the approved baseline.
 *
 * Returns a description only. A remote seen on chain but absent from the
 * manifest is candidate drift, reported and not trusted; it is never added.
 */
export const diffAgainstBaseline = (
  census: CandidateCensus,
  approved: readonly ApprovedRemote[],
  baselineDigest: string,
): DiscoveryDiff => {
  const drift: DriftEntry[] = [];
  const approvedByKey = new Map(
    approved.map((a) => [key(a.remoteBlockchainId, a.remoteTokenTransferrerAddress), a]),
  );
  const observedByKey = new Map(
    census.remotes.map((r) => [key(r.remoteBlockchainId, r.remoteTokenTransferrerAddress), r]),
  );

  for (const [k, r] of observedByKey) {
    const match = approvedByKey.get(k);
    if (match === undefined) {
      drift.push({
        kind: 'candidate-not-approved',
        remoteBlockchainId: r.remoteBlockchainId,
        remoteTokenTransferrerAddress: r.remoteTokenTransferrerAddress,
        detail:
          'registered on chain but not present in the approved baseline; candidate drift, not trusted',
      });
      continue;
    }
    if (match.expectedDecimals !== r.remoteTokenDecimals) {
      drift.push({
        kind: 'decimals-mismatch',
        remoteBlockchainId: r.remoteBlockchainId,
        remoteTokenTransferrerAddress: r.remoteTokenTransferrerAddress,
        detail: `registered with ${String(r.remoteTokenDecimals)} decimals, baseline expects ${String(match.expectedDecimals)}`,
      });
    }
  }

  for (const [k, a] of approvedByKey) {
    if (!observedByKey.has(k)) {
      drift.push({
        kind: 'approved-not-observed',
        remoteBlockchainId: a.remoteBlockchainId.toLowerCase(),
        remoteTokenTransferrerAddress: a.remoteTokenTransferrerAddress.toLowerCase(),
        detail:
          'present in the approved baseline but no registration was observed in the scanned range',
      });
    }
  }

  return {
    baselineDigest,
    censusCompleteness: census.completeness,
    drift,
    mutatesBaseline: false,
  };
};

/**
 * Whether a candidate may be evaluated at all.
 *
 * Without an approved manifest there is nothing to compare against, and a
 * permissionless registration is not a baseline. The answer is UNKNOWN rather
 * than a verdict computed from whatever happened to be on chain.
 */
export type BaselineGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'BASELINE_REQUIRED'; readonly reason: string };

export const requireApprovedBaseline = (
  approvedManifestDigest: string | undefined,
): BaselineGate =>
  approvedManifestDigest === undefined || approvedManifestDigest === ''
    ? {
        ok: false,
        code: 'BASELINE_REQUIRED',
        reason:
          'no approved manifest digest; a discovered topology is a candidate and cannot stand in for an operator-approved baseline',
      }
    : { ok: true };
