import { aggregate, type AggregationInput } from '@ictt-sentinel/invariant-core';
import { canonicalStringify } from './canonical.js';
import { hashCore } from './hash.js';
import { assertSecretFree, findSecrets } from './redact.js';
import { EVIDENCE_SCHEMA_VERSION, type EvidenceBundle } from './schema.js';

/**
 * Offline verifier.
 *
 * What it establishes:
 *   - the bundle matches its own schema version and content hash;
 *   - every internal reference resolves;
 *   - re-running the pure engine over the bundle's own inputs reproduces the
 *     recorded verdict;
 *   - nothing that looks like a credential is inside it.
 *
 * What it does NOT establish, stated in the output rather than buried here: that
 * the RPC witnesses told the truth. Independent readers agreeing is evidence
 * that they agree. It is not a cryptographic proof, and no amount of offline
 * checking can turn it into one.
 */

export const VERIFY_FAILURES = [
  'schema-version-unknown',
  'content-hash-mismatch',
  'dangling-reference',
  'missing-required-evidence',
  'verdict-mismatch',
  'secret-present',
  'not-canonical',
] as const;
export type VerifyFailure = (typeof VERIFY_FAILURES)[number];

export interface VerifyFinding {
  readonly failure: VerifyFailure;
  readonly detail: string;
}

export interface VerifyResult {
  readonly verified: boolean;
  readonly findings: readonly VerifyFinding[];
  readonly recomputedHash: string;
  /** Assumptions the verifier could NOT check. Always populated. */
  readonly trustBoundary: readonly string[];
}

/**
 * The limits of offline verification, written into every result.
 *
 * A verifier that only says "verified" invites the reader to believe more than
 * was checked, and that over-reading is the failure this product exists not to
 * cause.
 */
const TRUST_BOUNDARY: readonly string[] = [
  'Whether the RPC providers reported the truth is NOT verified here; quorum records that independent readers agreed, which is not a cryptographic or Byzantine guarantee.',
  'Whether the deployed runtime bytecode matches the operator-attested fingerprint is not re-checked offline; it is attested in the manifest.',
  'Whether every path that reduces native supply is captured by the two burn addresses is an unverified upstream assumption.',
  'This bundle is reproducible and tamper-evident, not tamper-proof: anyone who can edit the file can recompute its hash.',
];

/** Rebuild the aggregation input the bundle recorded, so it can be re-run. */
export interface ReplayInputs {
  readonly aggregation: AggregationInput;
}

/**
 * Verify a bundle.
 *
 * `replayInputs` is supplied by the caller because reconstructing engine inputs
 * from the bundle is deployment-shaped work; what this function owns is that the
 * REPLAYED verdict must equal the RECORDED one, and that everything else about
 * the document holds together.
 */
export const verifyBundle = (
  bundle: EvidenceBundle,
  replayInputs: ReplayInputs | null,
): VerifyResult => {
  const findings: VerifyFinding[] = [];

  // A bundle read from disk is untrusted input: its declared version is whatever
  // the file says, not what the type claims.
  const declared: string = bundle.core.producer.schemaVersion;
  if (declared !== EVIDENCE_SCHEMA_VERSION) {
    // An unknown schema is refused rather than best-effort parsed: a partial
    // read of a document whose meaning changed is worse than no read.
    findings.push({
      failure: 'schema-version-unknown',
      detail: `bundle declares ${declared}, this verifier understands ${String(EVIDENCE_SCHEMA_VERSION)}`,
    });
    return {
      verified: false,
      findings,
      recomputedHash: '',
      trustBoundary: TRUST_BOUNDARY,
    };
  }

  const recomputedHash = hashCore(bundle.core);
  if (recomputedHash !== bundle.contentHash) {
    findings.push({
      failure: 'content-hash-mismatch',
      detail: `recorded ${bundle.contentHash}, recomputed ${recomputedHash}`,
    });
  }

  // Internal references: every fact a rule or message cites must be present.
  const factDigests = new Set(bundle.core.rawFacts.map((f) => f.digest));
  for (const m of bundle.core.messages) {
    for (const t of m.timeline) {
      if (!factDigests.has(t.factDigest)) {
        findings.push({
          failure: 'dangling-reference',
          detail: `message ${m.messageId} cites unknown fact ${t.factDigest}`,
        });
      }
    }
  }

  // A bundle that admits missing evidence cannot verify as a pass.
  if (bundle.core.completeness.missingEvidence.length > 0) {
    findings.push({
      failure: 'missing-required-evidence',
      detail: bundle.core.completeness.missingEvidence.join(', '),
    });
  }
  if (bundle.core.completeness.contradictoryEvidence.length > 0) {
    findings.push({
      failure: 'missing-required-evidence',
      detail: `contradictory: ${bundle.core.completeness.contradictoryEvidence.join(', ')}`,
    });
  }

  // Re-run the pure engine and compare against what the bundle claims.
  if (replayInputs !== null) {
    const replayed = aggregate(replayInputs.aggregation);
    const recorded = bundle.core.verdict;
    const mismatches: string[] = [];
    if (replayed.protocolStatus !== recorded.protocolStatus) {
      mismatches.push(`protocolStatus ${recorded.protocolStatus} != ${replayed.protocolStatus}`);
    }
    if (replayed.dataStatus !== recorded.dataStatus) {
      mismatches.push(`dataStatus ${recorded.dataStatus} != ${replayed.dataStatus}`);
    }
    if (replayed.claimMode !== recorded.claimMode) {
      mismatches.push(`claimMode ${recorded.claimMode} != ${replayed.claimMode}`);
    }
    if (replayed.coverage !== recorded.coverage) {
      mismatches.push(`coverage ${recorded.coverage} != ${replayed.coverage}`);
    }
    if (mismatches.length > 0) {
      findings.push({ failure: 'verdict-mismatch', detail: mismatches.join('; ') });
    }
  }

  const serialised = canonicalStringify(bundle.core);
  const secrets = findSecrets(serialised);
  if (secrets.length > 0) {
    findings.push({
      failure: 'secret-present',
      detail: [...new Set(secrets.map((s) => s.pattern))].join(', '),
    });
  }

  return {
    verified: findings.length === 0,
    findings,
    recomputedHash,
    trustBoundary: TRUST_BOUNDARY,
  };
};

/** Guard used before writing: an unshippable bundle fails loudly. */
export const assertBundleShareable = (bundle: EvidenceBundle): void => {
  assertSecretFree(canonicalStringify(bundle.core));
};
