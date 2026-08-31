import {
  type ProtocolFamily,
  type SourceDescriptor,
  type SupportLevel,
  auditCoverageFor,
  validateDescriptor,
} from './descriptor.js';
import {
  PINNED_COMMIT_SHA,
  PINNED_REPOSITORY,
  SOURCE_DESCRIPTORS,
} from './descriptors/generated.js';
import {
  type ApprovedCodeHashes,
  type FingerprintResult,
  type ObservedContract,
  classifyFingerprint,
  isInterpretable,
} from './fingerprint.js';

/**
 * Adapter registry.
 *
 * Selection requires an exact protocol family plus an exact fingerprint match.
 * Nothing is fetched at runtime, nothing is inferred from a version number, and
 * an unrecognised contract is never interpreted.
 */

const descriptorProblems = SOURCE_DESCRIPTORS.flatMap(validateDescriptor);
if (descriptorProblems.length > 0) {
  // A malformed descriptor makes every later comparison meaningless, so this
  // build refuses to load rather than compare against a broken table.
  throw new Error(`source descriptor table is invalid:\n  ${descriptorProblems.join('\n  ')}`);
}

const BY_ID = new Map(SOURCE_DESCRIPTORS.map((d) => [d.adapterId, d]));

export const listDescriptors = (): readonly SourceDescriptor[] => SOURCE_DESCRIPTORS;

export const getDescriptor = (adapterId: string): SourceDescriptor | undefined =>
  BY_ID.get(adapterId);

/**
 * Families this build will interpret.
 *
 * `teleporter-v2-experimental` is absent on purpose: it is a separate,
 * unaudited source tree carrying an open authorization report, and a registry
 * protocol version never selects it (docs/PROTOCOL_SOURCE_LOCK.md section 4).
 */
export const INTERPRETABLE_FAMILIES: readonly ProtocolFamily[] = [
  'ictt',
  'teleporter',
  'utilities',
];

export type ResolutionOutcome = 'supported' | 'limited' | 'unsupported' | 'unknown';

export interface AdapterResolution {
  readonly outcome: ResolutionOutcome;
  readonly adapterId?: string;
  readonly descriptor?: SourceDescriptor;
  readonly fingerprint: FingerprintResult;
  readonly reasons: readonly string[];
  /** True only when the caller may decode with this adapter. */
  readonly interpretable: boolean;
}

const unresolved = (
  outcome: ResolutionOutcome,
  fingerprint: FingerprintResult,
  reasons: readonly string[],
): AdapterResolution => ({ outcome, fingerprint, reasons, interpretable: false });

/**
 * Resolve an observed contract to an adapter.
 *
 * `expectedFamily` comes from the operator's approved manifest, never from a
 * value read off chain. A registry protocol version is a different numbering
 * space and must not reach this function.
 */
export const resolveAdapter = (
  observed: ObservedContract,
  approved: readonly ApprovedCodeHashes[],
  expectedFamily: ProtocolFamily,
): AdapterResolution => {
  if (!INTERPRETABLE_FAMILIES.includes(expectedFamily)) {
    return unresolved('unsupported', { class: 'custom-or-unknown', reasons: [] }, [
      `protocol family "${expectedFamily}" is not interpreted by this build`,
      expectedFamily === 'teleporter-v2-experimental'
        ? 'the experimental source tree carries no audit and an open authorization report'
        : 'family is outside the source lock',
    ]);
  }

  const fingerprint = classifyFingerprint(observed, approved);
  if (!isInterpretable(fingerprint)) {
    const outcome: ResolutionOutcome =
      fingerprint.class === 'conflicting' || fingerprint.class === 'known-historical-epoch'
        ? 'unknown'
        : 'unknown';
    return unresolved(outcome, fingerprint, fingerprint.reasons);
  }

  const adapterId = fingerprint.adapterId;
  const descriptor = adapterId === undefined ? undefined : BY_ID.get(adapterId);
  if (descriptor === undefined) {
    return unresolved('unknown', fingerprint, [
      `fingerprint matched "${adapterId ?? '<none>'}", which is not in the source lock`,
    ]);
  }

  if (descriptor.family !== expectedFamily) {
    return unresolved('unknown', fingerprint, [
      `fingerprint resolves to family "${descriptor.family}" but the manifest expects "${expectedFamily}"`,
    ]);
  }

  if (descriptor.support === 'unsupported') {
    return unresolved('unsupported', fingerprint, [
      `"${descriptor.adapterId}" is present in the source lock but is not interpretable`,
    ]);
  }

  const reasons: string[] = [];
  const coverage = auditCoverageFor(descriptor, PINNED_COMMIT_SHA);
  if (coverage !== 'covered-at-pinned-commit') {
    // Recorded, not fatal: it bounds what may be claimed, and every audit
    // upstream names a commit that is not the one pinned here.
    reasons.push(`audit coverage: ${coverage}`);
  }
  if (descriptor.support === 'limited') {
    reasons.push('this contract supports a bounded claim only; see the support matrix');
  }

  return {
    outcome: descriptor.support,
    adapterId: descriptor.adapterId,
    descriptor,
    fingerprint,
    reasons,
    interpretable: true,
  };
};

/**
 * A Teleporter registry protocol version says which messenger version the
 * registry maps, and nothing about which source tree is deployed. This function
 * exists so the mistake has a name and a test, rather than being avoided by
 * convention.
 */
export const familyFromRegistryVersion = (_version: number): never => {
  throw new Error(
    'a Teleporter registry protocol version does not identify a protocol source family; ' +
      'resolve the family from the implementation fingerprint instead',
  );
};

export interface SourceLockSummary {
  readonly repository: string;
  readonly commitSha: string;
  readonly descriptorCount: number;
  readonly bySupport: Record<SupportLevel, number>;
}

export const sourceLockSummary = (): SourceLockSummary => {
  const bySupport: Record<SupportLevel, number> = { supported: 0, limited: 0, unsupported: 0 };
  for (const d of SOURCE_DESCRIPTORS) bySupport[d.support] += 1;
  return {
    repository: PINNED_REPOSITORY,
    commitSha: PINNED_COMMIT_SHA,
    descriptorCount: SOURCE_DESCRIPTORS.length,
    bySupport,
  };
};
