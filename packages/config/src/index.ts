// @ictt-sentinel/config
// Manifest and policy schema plus validation.
//
// This package parses injected input only: it never reads the filesystem and
// never reads process.env. The application supplies the document text and the
// environment map, which keeps a single auditable place where secrets enter
// the process (.claude/rules/apps.md).

export { ConfigError, type ConfigErrorCode, type ConfigIssue, issue } from './errors.js';
export { REDACTED, redact, redactToJson } from './redact.js';
export { DEFAULT_YAML_LIMITS, parseSafeYaml, type SafeYamlLimits } from './safe-yaml.js';
export { findInlineSecrets } from './inline-secret.js';
export { canonicalDigest, canonicalize, type Json } from './canonical.js';

export {
  ALLOWED_SECRET_REF_PREFIXES,
  FORBIDDEN_SECRET_NAMES,
  ResolvedSecret,
  assertNoForbiddenSecrets,
  parseSecretRef,
  requireSecrets,
  resolveSecrets,
  validateSecretRefName,
  type EnvSource,
  type SecretRef,
  type SecretResolution,
} from './secret-ref.js';

export {
  BASELINE_FIELDS,
  MANIFEST_KIND,
  SUPPORTED_MANIFEST_API_VERSIONS,
  zManifest,
  type ApprovedBaseline,
  type CandidateBaseline,
  type ChainIdentity,
  type Endpoint,
  type FieldPolicyMode,
  type Manifest,
  type ManifestSpec,
} from './schema/manifest.js';

export {
  POLICY_KIND,
  SUPPORTED_POLICY_API_VERSIONS,
  zPolicy,
  type Policy,
  type PolicySpec,
} from './schema/policy.js';

export { collectSecretRefs, loadManifest, loadPolicy, type LoadedDocument } from './load.js';

export {
  approveCandidate,
  exactReplayCapability,
  isApproved,
  isCandidate,
  requireExactReplay,
  type Approval,
  type Capability,
} from './baseline.js';
