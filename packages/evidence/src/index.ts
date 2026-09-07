// @ictt-sentinel/evidence
//
// Reproducible, audit-shareable evidence bundles and their offline verifier.
//
// Two promises, and only two: the same observations produce the same content
// hash, and any change to what a verdict rested on is detectable. The bundle is
// NOT tamper-proof, not immutable and not a Byzantine proof - whoever can edit
// the file can recompute its hash. The verifier says so in its own output.

export const PACKAGE_NAME = '@ictt-sentinel/evidence' as const;

export { EVIDENCE_SCHEMA_VERSION } from './schema.js';
export type {
  ApprovedBaselineRef,
  AssuranceRecord,
  CensusRecord,
  CompletenessRecord,
  ContractFingerprint,
  EvidenceBundle,
  EvidenceCore,
  EvidencePresentation,
  EvidenceSchemaVersion,
  MessageRecord,
  PinnedChain,
  ProducerIdentity,
  QuorumMatrix,
  RawFactRefRecord,
  RuleRecord,
  SourceLockRef,
  StateCallRecord,
  VerdictRecord,
  WitnessVote,
} from './schema.js';

export {
  canonicalise,
  canonicalStringify,
  toCanonicalValue,
  NonCanonicalValueError,
} from './canonical.js';
export type { CanonicalValue } from './canonical.js';

export { domainSeparatedSha256, hashCore, factDigest, stateCallDigest } from './hash.js';

export {
  REDACTED,
  SecretInEvidenceError,
  assertSecretFree,
  endpointPseudonym,
  findSecrets,
  redact,
} from './redact.js';
export type { SecretFinding } from './redact.js';

export { buildBundle, chainTo } from './bundle.js';
export type { BundleDraft } from './bundle.js';

export { VERIFY_FAILURES, assertBundleShareable, verifyBundle } from './verify.js';
export type { ReplayInputs, VerifyFailure, VerifyFinding, VerifyResult } from './verify.js';

export { renderHtml } from './html.js';
export { decodeProofInput, encodeProofInput, replayProof } from './replay.js';
