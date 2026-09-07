import { validBundleShape } from './validate.js';
import { decodeProofInput, replayProof } from './replay.js';
import { aggregate, type AggregationInput } from '@ictt-sentinel/invariant-core';
import { canonicalStringify } from './canonical.js';
import { hashCore, factDigest, stateCallDigest, domainSeparatedSha256 } from './hash.js';
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
  'schema-invalid',
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
  candidate: unknown,
  replayInputs: ReplayInputs | null = null,
): VerifyResult => {
  const findings: VerifyFinding[] = [];

  const failed = (failure: VerifyFailure): VerifyResult => ({
    verified: false,
    findings: [{ failure, detail: 'Bundle rejected; no untrusted values echoed.' }],
    recomputedHash: '',
    trustBoundary: TRUST_BOUNDARY,
  });
  try {
    const secrets = findSecrets(JSON.stringify(candidate));
    if (secrets.length > 0) return failed('secret-present');
    if (!validBundleShape(candidate)) return failed('schema-invalid');
  } catch {
    return failed('schema-invalid');
  }
  const bundle = candidate;
  if (String(bundle.core.producer.schemaVersion) !== EVIDENCE_SCHEMA_VERSION)
    return failed('schema-version-unknown');
  try {
    canonicalStringify(bundle);
  } catch {
    return failed('not-canonical');
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

  // Re-run the arithmetic using only the signed-by-nobody, self-contained core.
  try {
    const core = bundle.core;
    const input = decodeProofInput(core.replay.input);
    const replayed = replayProof(input);
    if (
      canonicalStringify(replayed.evaluation) !== canonicalStringify(core.replay.evaluation) ||
      canonicalStringify([replayed.rule]) !== canonicalStringify(core.rules) ||
      canonicalStringify(replayed.verdict) !== canonicalStringify(core.verdict)
    ) {
      findings.push({
        failure: 'verdict-mismatch',
        detail: 'Pure rule proof, intermediate arithmetic or full verdict differs.',
      });
    }
    if (replayInputs !== null) {
      const external = aggregate(replayInputs.aggregation);
      for (const key of Object.keys(core.verdict) as (keyof typeof core.verdict)[]) {
        if (canonicalStringify(external[key]) !== canonicalStringify(core.verdict[key])) {
          findings.push({
            failure: 'verdict-mismatch',
            detail: 'Optional external replay assertion differs.',
          });
          break;
        }
      }
    }
    const requireEvidence = (ok: boolean, detail: string): void => {
      if (!ok) findings.push({ failure: 'missing-required-evidence', detail });
    };
    const same = (a: unknown, b: unknown) => canonicalStringify(a) === canonicalStringify(b);
    requireEvidence(
      String(core.producer.producer) === 'ictt-sentinel' &&
        /^[0-9a-f]{64}$/.test(core.producer.artifactChecksum),
      'Invalid producer identity.',
    );
    requireEvidence(
      /^[0-9a-f]{64}$/.test(core.sourceLock.sourceLockHash),
      'Missing source-lock digest.',
    );
    requireEvidence(
      core.deploymentId === input.deploymentId &&
        core.baseline.manifestHash === input.provenance.manifestHash &&
        core.baseline.policyHash === input.provenance.policyHash &&
        core.sourceLock.commitSha === input.provenance.sourceLockCommitSha &&
        core.sourceLock.adapterId === input.provenance.adapterId &&
        core.sourceLock.adapterVersion === input.provenance.adapterVersion,
      'Provenance does not bind the replay input.',
    );
    requireEvidence(
      core.chains.length >= 2 &&
        core.fingerprints.length > 0 &&
        core.rawFacts.length > 0 &&
        core.stateCalls.length > 0 &&
        core.messages.length > 0,
      'Required observation collections are empty.',
    );
    requireEvidence(
      core.quorum.requiredGroups >= 2 &&
        core.quorum.requiredGroups === input.freshness.requiredWitnessGroups,
      'Invalid quorum threshold.',
    );
    const counts = core.chains.map((chain) => {
      const votes = core.quorum.votes.filter(
        (v) =>
          v.blockchainId === chain.blockchainId &&
          v.agreed &&
          v.agreedBlockHash === chain.blockHash,
      );
      requireEvidence(
        chain.acceptanceEvidence.length > 0 && chain.finalityBasis === 'accepted-quorum',
        'Acceptance capability missing.',
      );
      requireEvidence(
        /^(0|[1-9][0-9]*)$/.test(chain.blockNumber) && /^0x[0-9a-f]{64}$/.test(chain.blockHash),
        'Invalid block pin.',
      );
      const count = Math.min(
        new Set(votes.map((v) => v.trustDomain)).size,
        new Set(votes.map((v) => v.providerGroup)).size,
      );
      requireEvidence(count >= core.quorum.requiredGroups, 'Independent chain quorum unavailable.');
      return count;
    });
    requireEvidence(
      Math.min(...counts) === input.freshness.independentWitnessGroups &&
        Math.min(...counts) === core.quorum.independentGroups,
      'Witness counts differ from replay.',
    );
    requireEvidence(
      core.quorum.votes.every(
        (v) =>
          /^ep-[0-9a-f]+$/.test(v.endpointId) &&
          core.chains.some((c) => c.blockchainId === v.blockchainId),
      ),
      'Invalid witness reference.',
    );
    const pins = [
      ...input.remotes.flatMap((r) => [r.homePin, r.remotePin]),
      input.homeEscrow.homePin,
    ];
    requireEvidence(
      pins.every(
        (p) =>
          p !== null &&
          core.chains.some(
            (c) =>
              c.blockchainId === p.blockchainId &&
              c.blockNumber === p.blockNumber.toString() &&
              c.blockHash === p.blockHash,
          ),
      ),
      'Replay pin missing from chain observations.',
    );
    for (const fact of core.rawFacts) {
      requireEvidence(
        fact.digest ===
          factDigest(BigInt(fact.evmChainId), fact.blockHash, fact.txHash, fact.logIndex),
        'Raw fact coordinate digest differs.',
      );
      requireEvidence(
        core.chains.some((c) => c.evmChainId === fact.evmChainId && c.blockHash === fact.blockHash),
        'Raw fact block reference missing.',
      );
    }
    requireEvidence(
      new Set(core.rawFacts.map((f) => f.digest)).size === core.rawFacts.length,
      'Duplicate raw fact.',
    );
    const observations = new Map<string, string>();
    for (const call of core.stateCalls) {
      requireEvidence(!observations.has(call.observationPath), 'Duplicate state observation.');
      observations.set(call.observationPath, call.result);
      requireEvidence(
        core.chains.some(
          (c) =>
            c.blockchainId === call.blockchainId &&
            c.blockNumber === call.blockNumber &&
            c.blockHash === call.blockHash,
        ),
        'State call pin missing.',
      );
      requireEvidence(
        call.calldataDigest === domainSeparatedSha256('ictt-sentinel/calldata/v1', call.calldata) &&
          call.resultDigest === stateCallDigest(call.target, call.calldata, call.result) &&
          call.provenance.length > 0,
        'State call digest or provenance differs.',
      );
    }
    input.remotes.forEach((r, i) => {
      for (const field of ['transferredBalance', 'remoteTotalSupply'] as const)
        requireEvidence(
          r[field] !== null &&
            observations.get(`remotes.${String(i)}.${field}`) === String(r[field]),
          'Required remote state observation missing or contradictory.',
        );
    });
    requireEvidence(
      input.homeEscrow.escrowBalance !== null &&
        observations.get('homeEscrow.escrowBalance') === String(input.homeEscrow.escrowBalance),
      'Escrow observation missing or contradictory.',
    );
    requireEvidence(
      same(
        core.census.registeredRemotes,
        input.remotes.map((r) => `${r.remoteBlockchainId}/${r.remoteAddress}`),
      ) &&
        core.census.completeness === input.census &&
        core.census.missingRemotes.length === 0 &&
        core.census.remotesWithoutRpc.length === 0,
      'Census incomplete or contradictory.',
    );
    requireEvidence(
      core.completeness.fresh &&
        input.freshness.fresh &&
        Number.isFinite(Date.parse(core.completeness.observedAt)) &&
        Date.parse(core.completeness.expiresAt) > Date.parse(core.completeness.observedAt),
      'Freshness not established at the recorded evaluation time.',
    );
    requireEvidence(
      core.messages.every((m) => m.timeline.length > 0 && m.envelopeIds.length > 0),
      'Message lineage missing.',
    );
    for (const effect of input.effects)
      requireEvidence(
        effect.causalSourceFact !== null && factDigests.has(effect.causalSourceFact),
        'Effect source reference missing.',
      );
  } catch {
    findings.push({
      failure: 'schema-invalid',
      detail: 'Invalid or incomplete replay input; arithmetic was not verified.',
    });
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
  assertSecretFree(canonicalStringify(bundle));
};
