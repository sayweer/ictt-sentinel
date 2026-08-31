/**
 * Source descriptors.
 *
 * An adapter may only interpret a contract whose identity is pinned to an
 * immutable upstream commit. Nothing here is fetched at runtime: the descriptor
 * table is a build artifact, and the hashes were computed by reading the
 * official repository at one commit (docs/adr/0006-protocol-and-sdk-source-lock.md).
 */

/**
 * Protocol source families.
 *
 * `teleporter` and `teleporter-v2-experimental` are separate source trees, not
 * two versions of one thing. A registry protocol version is a different
 * numbering space and never selects a family
 * (docs/PROTOCOL_SOURCE_LOCK.md section 4).
 */
export const PROTOCOL_FAMILIES = [
  'ictt',
  'teleporter',
  'teleporter-v2-experimental',
  'utilities',
] as const;
export type ProtocolFamily = (typeof PROTOCOL_FAMILIES)[number];

export const CONTRACT_ROLES = [
  'erc20-token-home',
  'native-token-home',
  'erc20-token-remote',
  'native-token-remote',
  'teleporter-messenger',
  'teleporter-registry',
  'warp-adapter',
  'abstract-base',
  'library',
] as const;
export type ContractRole = (typeof CONTRACT_ROLES)[number];

/**
 * How far this build will go for a contract.
 *   supported   - deterministic interpretation
 *   limited     - interpreted, but the claim it can support is bounded
 *   unsupported - never interpreted; resolves to UNKNOWN
 */
export const SUPPORT_LEVELS = ['supported', 'limited', 'unsupported'] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

export interface SourceDescriptor {
  readonly adapterId: string;
  readonly adapterVersion: number;
  readonly family: ProtocolFamily;
  readonly role: ContractRole;
  readonly support: SupportLevel;

  readonly sourcePath: string;
  readonly sourceBytes: number;
  readonly sourceSha256: string;
  readonly sourceGitBlobSha: string;

  readonly bindingPath?: string;
  readonly abiSha256?: string;
  readonly abiEntries?: number;
  readonly creationBytecodeSha256?: string;
  readonly creationBytecodeBytes?: number;

  readonly reviewedAt: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

/**
 * Structural check over the descriptor table.
 *
 * Runs at module load and in test. A descriptor with a malformed hash would
 * make every later comparison meaningless, so it is caught where it is cheap.
 */
export const validateDescriptor = (d: SourceDescriptor): readonly string[] => {
  const problems: string[] = [];
  if (!HEX64.test(d.sourceSha256)) problems.push(`${d.adapterId}: sourceSha256 is not 32-byte hex`);
  if (!HEX40.test(d.sourceGitBlobSha))
    problems.push(`${d.adapterId}: sourceGitBlobSha is not a git blob id`);
  if (d.sourceBytes <= 0) problems.push(`${d.adapterId}: sourceBytes must be positive`);
  if (d.abiSha256 !== undefined && !HEX64.test(d.abiSha256)) {
    problems.push(`${d.adapterId}: abiSha256 is not 32-byte hex`);
  }
  if (d.creationBytecodeSha256 !== undefined && !HEX64.test(d.creationBytecodeSha256)) {
    problems.push(`${d.adapterId}: creationBytecodeSha256 is not 32-byte hex`);
  }
  // An abstract base has no deployable bytecode; anything concrete must have it.
  if (
    d.role !== 'abstract-base' &&
    d.role !== 'library' &&
    d.creationBytecodeSha256 === undefined
  ) {
    problems.push(`${d.adapterId}: a concrete contract must carry a creation bytecode hash`);
  }
  return problems;
};

/**
 * Audit coverage.
 *
 * The audits in the upstream repository name the exact commit they cover, and
 * that commit is not the one this build pins. Saying "the repository is audited"
 * would therefore be false, so coverage is stated per audit and resolved against
 * the pinned commit rather than assumed.
 */
export interface AuditRecord {
  readonly auditor: string;
  readonly published: string;
  /** Full commit the audit actually covers, resolved from the short sha upstream. */
  readonly auditedCommitSha: string;
  /** Repository the audited commit lives in. */
  readonly auditedRepository: string;
  /** Scope exactly as the upstream audit index states it. */
  readonly scope: string;
}

/** Verbatim from `icm-contracts/audits/README.md` at the pinned commit. */
export const AUDIT_RECORDS: readonly AuditRecord[] = [
  {
    auditor: 'OpenZeppelin',
    published: '2023-11-16',
    auditedCommitSha: '6ba46565a72a7dabb159d74963d7abc525fb6486',
    auditedRepository: 'https://github.com/ava-labs/icm-contracts',
    scope: 'All contracts in the top-level of contracts/teleporter/',
  },
  {
    auditor: 'Louis',
    published: '2024-01-10',
    auditedCommitSha: '9fcdf42da263f3e3d3a60ccf1272d9394eac06d4',
    auditedRepository: 'https://github.com/ava-labs/icm-contracts',
    scope: 'Some contracts in contracts/teleporter/registry and contracts/utilities',
  },
  {
    auditor: 'OpenZeppelin',
    published: '2024-06-26',
    auditedCommitSha: '9e03a1e5177e4ad8d1edcedf529e71bb2f4a8d99',
    auditedRepository: 'https://github.com/ava-labs/icm-contracts',
    scope: 'All contracts in contracts/ictt/ excluding mocks/',
  },
];

export type AuditCoverage =
  'covered-at-pinned-commit' | 'audited-at-a-different-commit' | 'never-audited';

/**
 * Audit coverage for a descriptor.
 *
 * Every audit above names a commit in the archived repository, and the pinned
 * source is a later commit in a different repository with a different path
 * layout. The upstream index itself warns about using code newer than the
 * audited commit, so nothing in this build may claim audited status.
 */
export const auditCoverageFor = (d: SourceDescriptor, pinnedCommitSha: string): AuditCoverage => {
  if (d.family === 'teleporter-v2-experimental') return 'never-audited';
  const matches = AUDIT_RECORDS.some((a) => a.auditedCommitSha === pinnedCommitSha);
  return matches ? 'covered-at-pinned-commit' : 'audited-at-a-different-commit';
};
