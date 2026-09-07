/**
 * Stable reason codes.
 *
 * Stable because they travel into evidence bundles and incident dedup keys: a
 * renamed code silently reopens every incident that referenced the old one.
 *
 * The language is chosen as carefully as the logic. A missing input is a
 * COVERAGE gap, never an economic finding, and nothing here is allowed to be
 * reported under a solvency headline (docs/INVARIANTS.md 1, CLAUDE.md 9).
 */

export const REASON_CODES = [
  // --- input contract, all UNKNOWN ------------------------------------------
  /** Manifest or policy hash absent; there is no approved baseline to judge against. */
  'ACC-I01-NO-APPROVED-BASELINE',
  /** Adapter or source-lock version missing, so the semantics are unattributed. */
  'ACC-I02-NO-SOURCE-LOCK-VERSION',
  /** The registered-remote census is not known to be complete. */
  'ACC-I03-CENSUS-INCOMPLETE',
  /** A required chain has no pinned (number, hash) context. */
  'ACC-I04-NO-PINNED-BLOCK',
  /** The causal cut is open or gapped; cause and effect are not both inside it. */
  'ACC-I05-CAUSAL-CUT-OPEN',
  /** Observations are past their freshness window. */
  'ACC-I06-STALE-OBSERVATION',
  /** A required state observation is missing entirely. */
  'ACC-I07-MISSING-OBSERVATION',
  /** Token units/decimals/scaling behaviour not established for this pair. */
  'ACC-I08-UNKNOWN-TOKEN-SCALE',

  // --- unsupported, all UNKNOWN ---------------------------------------------
  /** Not a source-locked canonical ERC20 single-hop deployment. */
  'ACC-U01-UNSUPPORTED-FAMILY',
  /** Bytecode or implementation fingerprint not recognised. */
  'ACC-U02-UNKNOWN-FINGERPRINT',
  /** Rebase, fee-on-transfer, blacklist or share-token wrapper without an adapter. */
  'ACC-U03-UNSUPPORTED-TOKEN-BEHAVIOUR',
  /** Multi-hop or remote-to-remote route; never flattened into one hop. */
  'ACC-U04-UNSUPPORTED-ROUTE',

  // --- Gate A, exact causal reconciliation ----------------------------------
  /** D - S equals the pending total exactly. The supported happy path. */
  'ACC-A00-RECONCILED',
  /**
   * D < S with full freshness, quorum, census and causal closure: representation
   * exists on the remote that home accounting does not back.
   */
  'ACC-A01-EXCESS-REMOTE-REPRESENTATION',
  /**
   * D - S does not equal the pending total. NOT an economic finding on its own:
   * missing history, a decoder fault or a stale state read produce the same shape.
   */
  'ACC-A02-DELTA-UNEXPLAINED',
  /** Two credited economic effects for one message route. */
  'ACC-A03-DUPLICATE-ECONOMIC-EFFECT',
  /** A mint or release with no unique authorised source message behind it. */
  'ACC-A04-UNAUTHORISED-MINT',
  /** A mint or release whose route, origin or transferrer does not match. */
  'ACC-A05-ROUTE-MISMATCH',
  /** Arithmetic left the uint256 range; no clamped answer is produced. */
  'ACC-A06-ARITHMETIC-OUT-OF-RANGE',

  // --- Gate B, physical home coverage ---------------------------------------
  /** Eligible escrow covers the conservative liability. */
  'ACC-B00-COVERAGE-SUFFICIENT',
  /** Escrow is below the conservative liability at the pinned block. */
  'ACC-B01-COVERAGE-SHORTFALL',
  /** A registered remote's liability is unknown; it cannot be counted as zero. */
  'ACC-B02-UNTRACKED-REMOTE-LIABILITY',
  /** Gate B was not evaluated because Gate A did not pass. */
  'ACC-B03-GATE-A-NOT-PASSED',

  // --- native, bounded claims only ------------------------------------------
  /** Reported upper bound is covered by eligible home coverage. */
  'ACC-N00-REPORTED-UPPER-BOUND-COVERED',
  /**
   * `U > A`. NOT a shortfall on its own: an unknown fee burn may already have
   * reduced real supply below the reported bound.
   */
  'ACC-N01-UPPER-BOUND-ABOVE-COVERAGE-INDETERMINATE',
  /** An independently established supply LOWER bound also exceeds coverage. */
  'ACC-N02-SUPPLY-LOWER-BOUND-EXCEEDS-COVERAGE',

  // --- native minter configuration ------------------------------------------
  /** A minting role beyond the approved roster. */
  'CFG-N01-UNEXPECTED-MINTER-ROLE',
  /** A mint with no authorised role behind it at that epoch. */
  'CFG-N02-UNAUTHORISED-NATIVE-MINT',
  /** Exclusivity cannot be claimed: the allow list is not enumerable. */
  'CFG-N03-NATIVE-MINTER-CENSUS-INCOMPLETE',
  /** The same burned-fee delta was reported more than once. */
  'CFG-N04-DUPLICATE-FEE-REPORT',
  /** The re-minted reward is not established as already inside totalMinted. */
  'CFG-N05-FEE-REMINT-SEMANTICS-UNVERIFIED',

  // --- baseline drift --------------------------------------------------------
  /** A required control differs from the approved baseline. */
  'CFG-D01-BASELINE-DRIFT',
  /** Discovered but not approved. Review required; never auto-trusted. */
  'CFG-D02-UNAPPROVED-CANDIDATE',
  /** A required control could not be established. */
  'CFG-D03-CONTROL-UNRESOLVED',

  // --- aggregation -----------------------------------------------------------
  /** A policy-required evaluation never ran. Never defaults to OK. */
  'AGG-M01-REQUIRED-EVALUATION-MISSING',
  /** A previously OK evaluation is past its freshness TTL. */
  'AGG-M02-PREVIOUS-OK-EXPIRED',
  /** An exception, timeout, parse error or null input on the evaluation path. */
  'AGG-M03-EVALUATION-FAULT',
  /** Independent witnesses disagree. */
  'AGG-M04-WITNESS-DIVERGENCE',

  // --- liveness and heuristic, never an economic headline --------------------
  /** Pending envelopes older than policy allows. A liveness signal only. */
  'ACC-L01-PENDING-AGE-EXCEEDED',
  /** Rate or volume anomaly. A signal, and never a collateral finding. */
  'RSK-H01-RATE-ANOMALY',
  /** Receipt delay. Liveness, not accounting. */
  'RSK-H02-RECEIPT-DELAY',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export interface ReasonMeta {
  readonly summary: string;
  /**
   * Four classes with four different user-facing languages. `heuristic` exists
   * so an anomaly signal has somewhere to live that is NOT an accounting claim:
   * a rate anomaly is never shown under a collateral headline
   * (docs/INVARIANTS.md 1).
   */
  readonly proofClass: 'coverage' | 'correctness' | 'liveness' | 'heuristic';
}

export const REASON_META: Readonly<Record<ReasonCode, ReasonMeta>> = {
  'ACC-I01-NO-APPROVED-BASELINE': {
    summary: 'No approved manifest/policy hash to evaluate against',
    proofClass: 'coverage',
  },
  'ACC-I02-NO-SOURCE-LOCK-VERSION': {
    summary: 'Adapter or source-lock version missing from the proof input',
    proofClass: 'coverage',
  },
  'ACC-I03-CENSUS-INCOMPLETE': {
    summary: 'Registered remote census is not established as complete',
    proofClass: 'coverage',
  },
  'ACC-I04-NO-PINNED-BLOCK': {
    summary: 'A required chain has no pinned block number and hash',
    proofClass: 'coverage',
  },
  'ACC-I05-CAUSAL-CUT-OPEN': {
    summary: 'Causal cut is not closed across the chains involved',
    proofClass: 'coverage',
  },
  'ACC-I06-STALE-OBSERVATION': {
    summary: 'Observations are past their freshness window',
    proofClass: 'coverage',
  },
  'ACC-I07-MISSING-OBSERVATION': {
    summary: 'A required state observation is absent',
    proofClass: 'coverage',
  },
  'ACC-I08-UNKNOWN-TOKEN-SCALE': {
    summary: 'Token scaling behaviour is not established for this pair',
    proofClass: 'coverage',
  },
  'ACC-U01-UNSUPPORTED-FAMILY': {
    summary: 'Not a source-locked canonical ERC20 single-hop deployment',
    proofClass: 'coverage',
  },
  'ACC-U02-UNKNOWN-FINGERPRINT': {
    summary: 'Contract fingerprint is not recognised',
    proofClass: 'coverage',
  },
  'ACC-U03-UNSUPPORTED-TOKEN-BEHAVIOUR': {
    summary: 'Token behaviour breaks the canonical rule and has no adapter',
    proofClass: 'coverage',
  },
  'ACC-U04-UNSUPPORTED-ROUTE': {
    summary: 'Route is multi-hop or remote-to-remote',
    proofClass: 'coverage',
  },
  'ACC-A00-RECONCILED': {
    summary: 'Transferred balance minus remote supply equals the pending total',
    proofClass: 'correctness',
  },
  'ACC-A01-EXCESS-REMOTE-REPRESENTATION': {
    summary: 'Remote supply exceeds home accounting under a closed causal cut',
    proofClass: 'correctness',
  },
  'ACC-A02-DELTA-UNEXPLAINED': {
    summary: 'Delta does not match pending envelopes; cause not established',
    proofClass: 'coverage',
  },
  'ACC-A03-DUPLICATE-ECONOMIC-EFFECT': {
    summary: 'One message route carries more than one credited effect',
    proofClass: 'correctness',
  },
  'ACC-A04-UNAUTHORISED-MINT': {
    summary: 'A credited effect has no unique authorised source message',
    proofClass: 'correctness',
  },
  'ACC-A05-ROUTE-MISMATCH': {
    summary: 'A credited effect names a route that does not match its source',
    proofClass: 'correctness',
  },
  'ACC-A06-ARITHMETIC-OUT-OF-RANGE': {
    summary: 'Scaling left the uint256 range',
    proofClass: 'coverage',
  },
  'ACC-B00-COVERAGE-SUFFICIENT': {
    summary: 'Observed escrow covers the conservative liability at the pinned block',
    proofClass: 'coverage',
  },
  'ACC-B01-COVERAGE-SHORTFALL': {
    summary: 'Observed escrow is below the conservative liability at the pinned block',
    proofClass: 'coverage',
  },
  'ACC-B02-UNTRACKED-REMOTE-LIABILITY': {
    summary: 'A registered remote has unknown liability and cannot be counted as zero',
    proofClass: 'coverage',
  },
  'ACC-B03-GATE-A-NOT-PASSED': {
    summary: 'Physical coverage not evaluated because reconciliation did not pass',
    proofClass: 'coverage',
  },
  'ACC-L01-PENDING-AGE-EXCEEDED': {
    summary: 'Pending envelopes are older than policy allows',
    proofClass: 'liveness',
  },
  'ACC-N00-REPORTED-UPPER-BOUND-COVERED': {
    summary: 'Reported native supply upper bound is covered by eligible home coverage',
    proofClass: 'coverage',
  },
  'ACC-N01-UPPER-BOUND-ABOVE-COVERAGE-INDETERMINATE': {
    summary: 'Reported upper bound exceeds coverage; the evidence does not decide it',
    proofClass: 'coverage',
  },
  'ACC-N02-SUPPLY-LOWER-BOUND-EXCEEDS-COVERAGE': {
    summary: 'An established supply lower bound also exceeds eligible coverage',
    proofClass: 'correctness',
  },
  'CFG-N01-UNEXPECTED-MINTER-ROLE': {
    summary: 'An address holds a minting role beyond the approved roster',
    proofClass: 'correctness',
  },
  'CFG-N02-UNAUTHORISED-NATIVE-MINT': {
    summary: 'A native mint was observed with no authorised role at that epoch',
    proofClass: 'correctness',
  },
  'CFG-N03-NATIVE-MINTER-CENSUS-INCOMPLETE': {
    summary: 'Minter exclusivity cannot be established; the allow list is not enumerable',
    proofClass: 'coverage',
  },
  'CFG-N04-DUPLICATE-FEE-REPORT': {
    summary: 'The same burned-fee delta was reported more than once',
    proofClass: 'correctness',
  },
  'CFG-N05-FEE-REMINT-SEMANTICS-UNVERIFIED': {
    summary: 'Re-minted fee reward is not established as already counted in totalMinted',
    proofClass: 'coverage',
  },
  'CFG-D01-BASELINE-DRIFT': {
    summary: 'A required control differs from the approved baseline',
    proofClass: 'correctness',
  },
  'CFG-D02-UNAPPROVED-CANDIDATE': {
    summary: 'Discovered but not approved; operator review required',
    proofClass: 'coverage',
  },
  'CFG-D03-CONTROL-UNRESOLVED': {
    summary: 'A required control could not be established',
    proofClass: 'coverage',
  },
  'AGG-M01-REQUIRED-EVALUATION-MISSING': {
    summary: 'A policy-required evaluation did not run',
    proofClass: 'coverage',
  },
  'AGG-M02-PREVIOUS-OK-EXPIRED': {
    summary: 'A previously passing evaluation is past its freshness window',
    proofClass: 'coverage',
  },
  'AGG-M03-EVALUATION-FAULT': {
    summary: 'The evaluation path raised a fault instead of producing a result',
    proofClass: 'coverage',
  },
  'AGG-M04-WITNESS-DIVERGENCE': {
    summary: 'Independent witnesses disagree about the observed state',
    proofClass: 'coverage',
  },
  'RSK-H01-RATE-ANOMALY': {
    summary: 'Transfer rate or volume is unusual for this deployment',
    proofClass: 'heuristic',
  },
  'RSK-H02-RECEIPT-DELAY': {
    summary: 'Relayer receipts are arriving later than usual',
    proofClass: 'liveness',
  },
};

/**
 * Language that must never appear in a reason summary.
 *
 * Asserted by test rather than trusted to review: the product's only real asset
 * is that it does not manufacture false certainty (docs/SUPPORT_MATRIX.md 8).
 */
export const FORBIDDEN_CLAIM_WORDS = [
  'proof of reserves',
  'solvent',
  'insolvent',
  'guaranteed',
  'tamper-proof',
  'undercollateralized',
  'undercollateralised',
] as const;
