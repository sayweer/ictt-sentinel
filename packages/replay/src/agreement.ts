import type { RangeResult } from './range.js';
import type { ReplayReason } from './reasons.js';

/**
 * Witness agreement over one range.
 *
 * Quorum is counted over independent `providerGroup` values, never over
 * endpoints or URLs: two URLs behind one upstream are one witness, and counting
 * them twice manufactures agreement that does not exist (docs/INVARIANTS.md,
 * docs/adr/0002-accepted-quorum-truth.md).
 *
 * This is not a cryptographic or Byzantine guarantee and is never described as
 * one. It is the statement "n independent groups returned the same bytes".
 */

export interface AgreementPolicy {
  /** Independent provider groups that must agree before anything is committed. */
  readonly requiredIndependentGroups: number;
  /**
   * Whether an archive witness may count towards the quorum. Only true when the
   * manifest declares an archive endpoint that is independent of the others.
   */
  readonly archiveFallbackDeclared: boolean;
}

export type Agreement =
  | { readonly kind: 'agreed'; readonly digest: string; readonly witnesses: readonly RangeResult[] }
  | {
      readonly kind: 'blocked';
      readonly reason: ReplayReason;
      /** Digest -> the groups that reported it. Kept for the incident record. */
      readonly byDigest: ReadonlyMap<string, readonly string[]>;
    };

/**
 * Decide whether a range may become fact.
 *
 * Three ways to end up blocked, and all three keep the checkpoint where it is:
 *   - an archive witness was used but policy never declared one;
 *   - too few independent groups answered;
 *   - the groups that answered do not agree.
 *
 * The majority is deliberately NOT taken when groups diverge. Two providers
 * agreeing and one disagreeing is not "two out of three": it is evidence that
 * the chain view is not settled, and the honest answer is UNKNOWN.
 */
export const agree = (results: readonly RangeResult[], policy: AgreementPolicy): Agreement => {
  const byDigest = new Map<string, string[]>();
  for (const r of results) {
    const groups = byDigest.get(r.digest);
    if (groups) groups.push(r.providerGroup);
    else byDigest.set(r.digest, [r.providerGroup]);
  }
  const frozen: ReadonlyMap<string, readonly string[]> = byDigest;

  const usedUndeclaredArchive =
    results.some((r) => r.viaArchive) && !policy.archiveFallbackDeclared;
  if (usedUndeclaredArchive) {
    return { kind: 'blocked', reason: 'ARCHIVE_FALLBACK_UNAVAILABLE', byDigest: frozen };
  }

  if (byDigest.size > 1) {
    return { kind: 'blocked', reason: 'PROVIDER_DIVERGENCE', byDigest: frozen };
  }

  // Distinct groups, not distinct results: a group that answered twice is still
  // one witness.
  const independent = new Set(results.map((r) => r.providerGroup));
  if (independent.size < policy.requiredIndependentGroups) {
    return { kind: 'blocked', reason: 'INSUFFICIENT_WITNESSES', byDigest: frozen };
  }

  const [digest] = [...byDigest.keys()];
  if (digest === undefined) {
    return { kind: 'blocked', reason: 'INSUFFICIENT_WITNESSES', byDigest: frozen };
  }

  // One result per group, so the witness list mirrors the independence count.
  const witnesses = [...independent]
    .sort()
    .map((g) => results.find((r) => r.providerGroup === g))
    .filter((r): r is RangeResult => r !== undefined);

  return { kind: 'agreed', digest, witnesses };
};

/**
 * Provenance recorded alongside a committed range.
 *
 * `requiredIndependentGroups` travels with the evidence so a later reader can
 * tell what the threshold was at the time, rather than assuming today's policy.
 */
export interface WitnessProvenance {
  readonly digest: string;
  readonly providerGroups: readonly string[];
  readonly requiredIndependentGroups: number;
  readonly startBlockHash: string;
  readonly endBlockHash: string;
}

export const provenanceOf = (
  agreement: Extract<Agreement, { kind: 'agreed' }>,
  policy: AgreementPolicy,
): WitnessProvenance => {
  const first = agreement.witnesses[0];
  if (!first) throw new Error('an agreed range must carry at least one witness');
  return {
    digest: agreement.digest,
    providerGroups: agreement.witnesses.map((w) => w.providerGroup),
    requiredIndependentGroups: policy.requiredIndependentGroups,
    startBlockHash: first.startBlockHash,
    endBlockHash: first.endBlockHash,
  };
};
