import { canonicalDigest } from './canonical.js';
import { ConfigError, issue } from './errors.js';
import type { ApprovedBaseline, CandidateBaseline, Manifest } from './schema/manifest.js';

/**
 * Candidate discovery and approved baseline are separate types on purpose.
 *
 * Anyone can deploy and register a remote token transferrer, and the official
 * ICTT documentation puts the burden of evaluating it on the operator. So an
 * observed topology is a *candidate*: something to review. Drift detection only
 * means anything against a baseline a human approved (docs/PRODUCT.md 4, 6).
 *
 * There is deliberately no function that turns a candidate into an approved
 * baseline without an explicit approval record.
 */

export interface Approval {
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly note?: string;
}

export const isApproved = (b: CandidateBaseline | ApprovedBaseline): b is ApprovedBaseline =>
  b.state === 'approved';

export const isCandidate = (b: CandidateBaseline | ApprovedBaseline): b is CandidateBaseline =>
  b.state === 'candidate';

/**
 * Promote a reviewed candidate.
 *
 * `reviewedDigest` records what was actually read. If the manifest changed
 * between review and approval the digests disagree and the promotion is
 * refused, so an approval cannot be transplanted onto different content.
 */
export const approveCandidate = (
  candidate: CandidateBaseline,
  reviewedDocument: unknown,
  approval: Approval,
): ApprovedBaseline => {
  const reviewedDigest = canonicalDigest(reviewedDocument);
  return {
    state: 'approved',
    approval: {
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
      reviewedDigest,
      ...(approval.note === undefined ? {} : { note: approval.note }),
    },
    fieldPolicies: candidate.fieldPolicies,
  };
};

/**
 * Capabilities a manifest unlocks.
 *
 * Exact replay reconstructs history from a start block and compares pinned
 * state across chains. Without an anchored chain identity, a start block and a
 * finality semantic it cannot be exact, so it stays closed rather than running
 * and producing a number nobody can reproduce.
 */
export interface Capability {
  readonly enabled: boolean;
  readonly blockedBy: readonly string[];
}

export const exactReplayCapability = (m: Manifest): Capability => {
  const blockedBy: string[] = [];

  if (isCandidate(m.spec.baseline)) {
    blockedBy.push('baseline is a candidate discovery and has not been approved by an operator');
  }

  const chains = [
    { label: 'home', chain: m.spec.home.chain },
    ...m.spec.remotes.map((r) => ({ label: `remote:${r.name}`, chain: r.chain })),
  ];

  for (const { label, chain } of chains) {
    if (chain.genesisHash === undefined && chain.trustedCheckpoint === undefined) {
      blockedBy.push(
        `${label}: chain identity is not anchored (no genesisHash or trustedCheckpoint)`,
      );
    }
    if (chain.finality.acceptedStateQueries !== 'accepted-only') {
      blockedBy.push(`${label}: endpoints are not asserted to answer from accepted state only`);
    }
    const domains = new Set(chain.endpoints.map((e) => e.trustDomain));
    if (domains.size < chain.quorum.independentTrustDomains) {
      blockedBy.push(`${label}: fewer independent trust domains than the declared quorum`);
    }
    if (!chain.endpoints.some((e) => e.archiveDepth === 'full')) {
      blockedBy.push(
        `${label}: no endpoint declares full archive depth, so historical replay may gap`,
      );
    }
  }

  if (m.spec.census.completeness !== 'complete-from-deployment-block') {
    blockedBy.push('census completeness is not established from the TokenHome deployment block');
  }

  return { enabled: blockedBy.length === 0, blockedBy };
};

/** Throwing variant for commands that must not proceed on partial evidence. */
export const requireExactReplay = (m: Manifest): void => {
  const cap = exactReplayCapability(m);
  if (!cap.enabled) {
    throw new ConfigError(
      cap.blockedBy.map((reason) => issue('BASELINE_NOT_APPROVED', 'spec', reason)),
      'exact replay is not available for this manifest',
    );
  }
};
