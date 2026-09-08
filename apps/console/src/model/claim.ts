/**
 * Claim language.
 *
 * Every user-facing sentence about coverage is produced here, by one of two
 * vocabularies that must never mix:
 *
 *   canonical ERC20  a deterministic reconciliation. `D_r - S_r = P_h2r + P_r2h`
 *                    either holds at the pinned blocks or it does not.
 *   native           an accounting reconstruction with an unbacked initial
 *                    reserve. Only `sufficient` / `indeterminate` / `unknown`
 *                    are sayable; exact circulating-supply equality is NOT
 *                    (docs/INVARIANTS.md 7, CLAUDE.md 5).
 *
 * `assertBoundedLanguage` runs over everything this module emits, and the tests
 * run it over every string the console can render. That turns "we promised not
 * to say solvent" from a review habit into a checked property.
 */

export const ASSET_MODES = ['canonical-erc20', 'native'] as const;
export type AssetMode = (typeof ASSET_MODES)[number];

export const CLAIM_MODES = [
  'EXACT',
  'CAUSAL_EXACT',
  'SUFFICIENT_UPPER_BOUND',
  'INDETERMINATE',
  'UNSUPPORTED',
] as const;
export type ClaimMode = (typeof CLAIM_MODES)[number];

export const COVERAGE_STATES = ['COMPLETE', 'PARTIAL', 'UNVERIFIED'] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

/**
 * Claims this product cannot make, in any screen, at any severity.
 *
 * Checked on the way out rather than trusted to reviewers. `solvent` matches
 * `solvency` too, which is deliberate: the noun is no more sayable than the
 * adjective.
 */
export const FORBIDDEN_CLAIMS: readonly RegExp[] = [
  /\bproof of reserves\b/i,
  /\bsolvent\b/i,
  /\bsolvency\b/i,
  /\bguarantee[ds]?\b/i,
  /\btamper[- ]proof\b/i,
  /\bfully backed\b/i,
  /\bprovably safe\b/i,
  /\bexact (?:total )?supply\b/i,
  /\bcannot be exploited\b/i,
];

export class ForbiddenClaimError extends Error {
  override readonly name = 'ForbiddenClaimError';
  readonly matched: string;
  constructor(matched: string) {
    super(`refusing to render the claim ${JSON.stringify(matched)}`);
    this.matched = matched;
  }
}

export const assertBoundedLanguage = (text: string): string => {
  for (const rx of FORBIDDEN_CLAIMS) {
    const m = rx.exec(text);
    if (m !== null) throw new ForbiddenClaimError(m[0]);
  }
  return text;
};

export interface ClaimCopy {
  readonly headline: string;
  readonly detail: string;
  /** What this claim explicitly does not say. Rendered, not just documented. */
  readonly notClaimed: string;
}

const CANONICAL: Readonly<Record<ClaimMode, ClaimCopy>> = {
  EXACT: {
    headline: 'Exact reconciliation',
    detail:
      'Home-side liabilities and remote-side supply reconcile exactly at the pinned blocks, including pending envelopes.',
    notClaimed: 'This is observed onchain coverage, not a statement about legal recoverability.',
  },
  CAUSAL_EXACT: {
    headline: 'Exact once settled envelopes are accounted for',
    detail:
      'The reconciliation holds after in-flight envelopes that are causally settled are included.',
    notClaimed: 'Envelopes still in flight are listed separately and are not treated as delivered.',
  },
  SUFFICIENT_UPPER_BOUND: {
    headline: 'Not applicable to canonical ERC20',
    detail:
      'An upper-bound assessment belongs to the native vocabulary. A canonical ERC20 deployment reconciles deterministically or it does not.',
    notClaimed: 'No upper-bound language is used for a canonical ERC20 deployment.',
  },
  INDETERMINATE: {
    headline: 'The evidence does not decide this',
    detail: 'Reconciliation could not be established either way from what was observed.',
    notClaimed: 'Undecided is not a pass. Nothing here says the deployment is healthy.',
  },
  UNSUPPORTED: {
    headline: 'Deployment shape not interpreted by this build',
    detail:
      'The contracts do not match a source-locked shape this build knows how to read, so no reconciliation is attempted.',
    notClaimed: 'An unsupported shape is reported as unknown, never as passing.',
  },
};

const NATIVE: Readonly<Record<ClaimMode, ClaimCopy>> = {
  EXACT: {
    headline: 'Not available for native mode',
    detail:
      'The reported native supply is an accounting reconstruction that includes an unbacked initial reserve, so equality is not claimable.',
    notClaimed: 'No exact-equality claim is ever made for a native remote.',
  },
  CAUSAL_EXACT: {
    headline: 'Not available for native mode',
    detail: 'Causal-exact reconciliation belongs to the canonical ERC20 vocabulary.',
    notClaimed: 'No exact-equality claim is ever made for a native remote.',
  },
  SUFFICIENT_UPPER_BOUND: {
    headline: 'Reported supply upper bound is covered',
    detail:
      'The reconstructed upper bound U does not exceed the observed home-side coverage A at the pinned blocks.',
    notClaimed:
      'This is an upper bound, not a supply figure, and it holds only under the stated minter-exclusivity and burn-path assumptions.',
  },
  INDETERMINATE: {
    headline: 'Indeterminate',
    detail:
      'The reconstructed upper bound exceeds the observed coverage. On its own this is not a shortfall: an unobserved fee burn may already have reduced real supply.',
    notClaimed:
      'A red economic verdict needs a trustworthy supply lower bound to exceed coverage as well.',
  },
  UNSUPPORTED: {
    headline: 'Deployment shape not interpreted by this build',
    detail: 'The native remote does not match a source-locked shape this build knows how to read.',
    notClaimed: 'An unsupported shape is reported as unknown, never as passing.',
  },
};

/** Copy for one claim, in the vocabulary of that asset mode and no other. */
export const claimCopy = (mode: AssetMode, claim: ClaimMode): ClaimCopy => {
  const copy = mode === 'native' ? NATIVE[claim] : CANONICAL[claim];
  assertBoundedLanguage(`${copy.headline} ${copy.detail} ${copy.notClaimed}`);
  return copy;
};

const COVERAGE: Readonly<Record<CoverageState, string>> = {
  COMPLETE: 'Every approved remote in the census was observed at a pinned block.',
  PARTIAL: 'Some approved remotes could not be observed. Coverage is incomplete and is not netted.',
  UNVERIFIED: 'Coverage was not established. Treat the liability side as unknown.',
};

export const coverageCopy = (state: CoverageState): string => COVERAGE[state];

/**
 * The standing caveat.
 *
 * Rendered on every coverage surface, not buried in a footer: the difference
 * between "the chain balances" and "the money is recoverable" is the single
 * most expensive misreading this product can cause (CLAUDE.md 9).
 */
export const COVERAGE_CAVEAT =
  'Observed onchain coverage at pinned blocks. This is not a legal or financial recoverability opinion, and it is not an audit of the contracts.' as const;

/** Native panels are separated from canonical ones in layout and in wording. */
export const NATIVE_PANEL_CAVEAT =
  'Native mode reports sufficient, indeterminate or unknown only. The reported supply is an accounting reconstruction, so no equality claim is made.' as const;
