import type { Verdict } from '@ictt-sentinel/domain';
import type { ReasonCode } from './reasons.js';

/**
 * Rule output.
 *
 * The internal proof result and the external verdict are separate values on
 * purpose. A rule can be internally FAIL while the verdict it justifies is only
 * a candidate, and a rule can be UNSUPPORTED without that ever reading as OK.
 */

export const PROOF_RESULTS = ['PASS', 'FAIL', 'UNKNOWN', 'UNSUPPORTED'] as const;
export type ProofResult = (typeof PROOF_RESULTS)[number];

export interface Measurement {
  readonly expected: bigint;
  readonly observed: bigint;
  /** `observed - expected`. Signed, because the direction carries meaning. */
  readonly delta: bigint;
  /** Which denomination the three numbers above are in. */
  readonly unit: 'remote-base-units' | 'home-base-units';
}

export interface PendingBreakdown {
  readonly homeToRemote: bigint;
  readonly remoteToHome: bigint;
  readonly total: bigint;
  readonly count: number;
  /** Envelopes past the policy age limit. Liveness, never a coverage claim. */
  readonly overAgeCount: number;
}

export interface EvidenceRefs {
  readonly pinnedBlocks: readonly string[];
  readonly witnessGroups: number;
  readonly requiredWitnessGroups: number;
  readonly sourceLockCommitSha: string | null;
  readonly adapterId: string | null;
  readonly adapterVersion: number | null;
}

export interface RuleOutput {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly result: ProofResult;
  /**
   * The verdict this rule would contribute. `UNKNOWN` never becomes `OK`
   * anywhere downstream (docs/adr/0003-fail-closed-verdicts.md).
   */
  readonly verdictCandidate: Verdict;
  readonly reasons: readonly ReasonCode[];
  readonly measurement: Measurement | null;
  readonly pending: PendingBreakdown | null;
  readonly evidence: EvidenceRefs;
  /** Stated plainly, because a coverage claim is only as good as these. */
  readonly assumptions: readonly string[];
  readonly exclusions: readonly string[];
  /** Content digest of the inputs, so the same inputs give the same output. */
  readonly inputDigest: string;
}

/**
 * Map an internal proof result to the verdict it may contribute.
 *
 * `UNSUPPORTED` and `UNKNOWN` both land on `UNKNOWN`: not understanding a
 * deployment and not being able to read it are different causes with the same
 * honest answer. Nothing maps to `OK` except `PASS`.
 */
export const verdictFor = (result: ProofResult, critical: boolean): Verdict => {
  switch (result) {
    case 'PASS':
      return 'OK';
    case 'FAIL':
      // Only a proven economic breach is CRITICAL; a policy or liveness failure
      // is a WARN and must never borrow the collateral headline.
      return critical ? 'CRITICAL' : 'WARN';
    case 'UNKNOWN':
    case 'UNSUPPORTED':
      return 'UNKNOWN';
  }
};

/** Only PASS is ever green. Asserted here so no caller has to remember it. */
export const isGreen = (o: RuleOutput): boolean =>
  o.result === 'PASS' && o.verdictCandidate === 'OK';
