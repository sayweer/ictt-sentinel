/**
 * The two internal assurance gates.
 *
 * Gate A is always required and is what this package implements. Gate B is a
 * deliberate non-goal under the assurance mode this product selected, and this
 * module exists so that stays enforced in code rather than remembered.
 */

/**
 * Assurance mode, fixed by docs/adr/0004-icm-assurance-scope.md.
 *
 * V0 verifies the accepted state of both chains agreed by an independent
 * provider quorum. It does not independently re-verify ICM BLS aggregate
 * signatures or the Warp predicate against a historical P-Chain validator set.
 */
export const ASSURANCE_MODE = 'ACCEPTED_STATE_ASSURANCE' as const;
export type AssuranceMode = typeof ASSURANCE_MODE;

export interface GateAResult {
  readonly passed: boolean;
  readonly missing: readonly string[];
}

export interface GateAInput {
  readonly chainIdentityVerified: boolean;
  readonly acceptedStateEstablished: boolean;
  readonly quorumAgreed: boolean;
  readonly independentTrustDomains: number;
  readonly requiredTrustDomains: number;
  readonly pinnedContextBuilt: boolean;
  readonly freshWithinPolicy: boolean;
}

/**
 * Gate A: accepted-state multi-RPC quorum, pinned reads, capability and identity.
 *
 * Every condition is required. There is no partial pass, because a verdict built
 * on a missing condition is exactly the confident wrong answer this product is
 * meant to avoid.
 */
export const evaluateGateA = (input: GateAInput): GateAResult => {
  const missing: string[] = [];
  if (!input.chainIdentityVerified)
    missing.push('chain identity was not verified against the manifest');
  if (!input.acceptedStateEstablished)
    missing.push('accepted-state semantics were not established for the endpoints');
  if (!input.quorumAgreed) missing.push('the witness quorum did not agree');
  if (input.independentTrustDomains < input.requiredTrustDomains) {
    missing.push(
      `only ${String(input.independentTrustDomains)} independent trust domain(s), policy requires ${String(input.requiredTrustDomains)}`,
    );
  }
  if (!input.pinnedContextBuilt) missing.push('no pinned block context was produced');
  if (!input.freshWithinPolicy) missing.push('the observation is outside the freshness policy');
  return { passed: missing.length === 0, missing };
};

/**
 * Gate B: independent ICM verification.
 *
 * Out of scope under `ACCEPTED_STATE_ASSURANCE`. The capabilities below are
 * named so the boundary is concrete: none of them is implemented, and none may
 * be implied by the product's output.
 */
export const GATE_B_CAPABILITIES = [
  'unsigned-and-signed-warp-message-parsing',
  'warp-predicate-parsing',
  'aggregate-bls-signature-verification',
  'signer-bitset-and-weight-accounting',
  'historical-p-chain-validator-set-at-message-height',
  'subnet-weight-snapshot',
  'threshold-and-domain-binding',
  'retry-resign-and-new-message-lineage',
] as const;
export type GateBCapability = (typeof GATE_B_CAPABILITIES)[number];

export interface GateBStatus {
  readonly inScope: false;
  readonly mode: AssuranceMode;
  readonly unimplemented: readonly GateBCapability[];
  readonly claim: string;
}

/**
 * Gate B status.
 *
 * Returns a non-goal declaration rather than a result. Nothing in this package
 * verifies a BLS aggregate signature, and the product must not say otherwise
 * in its README, API, evidence or release notes.
 */
export const gateBStatus = (): GateBStatus => ({
  inScope: false,
  mode: ASSURANCE_MODE,
  unimplemented: GATE_B_CAPABILITIES,
  claim:
    'This build verifies accepted state agreed by an independent provider quorum. It does not ' +
    'independently verify ICM BLS aggregate signatures or the Warp predicate against a historical ' +
    'P-Chain validator set.',
});

/**
 * Phrases that would overstate the assurance this build provides.
 *
 * Exported so documentation and output can be scanned for them rather than
 * relying on everyone remembering the boundary.
 */
export const FORBIDDEN_ASSURANCE_CLAIMS = [
  'independently verifies icm',
  'independently verify icm',
  'verifies the bls signature',
  'bls signature verified',
  'warp-verified',
  'warp verified',
  'cryptographically verified message',
  'byzantine proof',
  'byzantine fault proof',
] as const;

/**
 * Any Gate B capability being called is a programming error under this mode.
 * Throwing keeps the boundary from eroding one convenience function at a time.
 */
export const requireGateB = (capability: GateBCapability): never => {
  throw new Error(
    `"${capability}" belongs to independent ICM verification, which is out of scope under ` +
      `${ASSURANCE_MODE}; implementing it requires a new ADR, source lock and test vectors`,
  );
};
