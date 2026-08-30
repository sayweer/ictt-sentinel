/**
 * Verdict lattice.
 *
 *   CRITICAL > required UNKNOWN > WARN > OK
 *
 * UNKNOWN is a first-class verdict and is never rendered as OK, healthy or green
 * (docs/adr/0003-fail-closed-verdicts.md).
 */
export const VERDICTS = ['OK', 'WARN', 'UNKNOWN', 'CRITICAL'] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * Whether a failing check blocks the overall result. A `required` check that
 * lands on UNKNOWN outranks WARN; an optional one does not.
 */
export type Requirement = 'required' | 'optional';

export interface Judgement {
  readonly verdict: Verdict;
  readonly requirement: Requirement;
}

/** Ranks encode the lattice. Higher wins when combining judgements. */
const RANK: Record<Verdict, number> = {
  OK: 0,
  WARN: 1,
  UNKNOWN: 2,
  CRITICAL: 3,
};

/** Inverse of RANK, so a combined rank maps back to the verdict it represents. */
const BY_RANK: readonly Verdict[] = ['OK', 'WARN', 'UNKNOWN', 'CRITICAL'];

/**
 * An UNKNOWN on a check nobody requires is a gap in optional coverage, not a
 * blocked evaluation, so it ranks as WARN. A required UNKNOWN keeps its own
 * rank and therefore outranks WARN.
 */
const rankOf = ({ verdict, requirement }: Judgement): number =>
  verdict === 'UNKNOWN' && requirement === 'optional' ? RANK.WARN : RANK[verdict];

/**
 * Combine judgements into the deployment-level verdict.
 *
 * The result is the verdict for the highest rank reached, not the raw verdict of
 * whichever judgement won: a demoted optional UNKNOWN must surface as WARN, or
 * the lattice would report a blocked state that does not exist.
 *
 * An empty input is UNKNOWN, not OK: having produced no evidence is precisely
 * the state the product must never paint green.
 */
export const combineVerdicts = (judgements: readonly Judgement[]): Verdict => {
  if (judgements.length === 0) return 'UNKNOWN';
  let highest = 0;
  for (const j of judgements) {
    const r = rankOf(j);
    if (r > highest) highest = r;
  }
  return BY_RANK[highest] ?? 'UNKNOWN';
};

/** True when a verdict may be surfaced as healthy. Only OK ever qualifies. */
export const isHealthy = (v: Verdict): boolean => v === 'OK';

/**
 * Proof class of a check. These carry different user-facing language: a
 * heuristic signal is never reported under a coverage headline
 * (docs/INVARIANTS.md 1).
 */
export const PROOF_CLASSES = ['coverage', 'correctness', 'liveness', 'heuristic'] as const;
export type ProofClass = (typeof PROOF_CLASSES)[number];

/**
 * Native-mode coverage outcome. Deliberately not a Verdict: the native reported
 * supply is an accounting reconstruction, so exact circulating-supply equality
 * is never claimed (docs/INVARIANTS.md 7, CLAUDE.md 5).
 */
export const SUPPLY_ASSESSMENTS = ['sufficient', 'indeterminate', 'unknown'] as const;
export type SupplyAssessment = (typeof SUPPLY_ASSESSMENTS)[number];

/** A supply assessment never reads as OK on its own; only `sufficient` is not blocking. */
export const supplyAssessmentToVerdict = (a: SupplyAssessment): Verdict => {
  switch (a) {
    case 'sufficient':
      return 'OK';
    case 'indeterminate':
      return 'UNKNOWN';
    case 'unknown':
      return 'UNKNOWN';
  }
};
