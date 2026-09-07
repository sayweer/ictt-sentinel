import { hashCore } from './hash.js';
import type { EvidenceBundle, EvidenceCore, EvidencePresentation } from './schema.js';
import { EVIDENCE_SCHEMA_VERSION } from './schema.js';

/**
 * Assembling a bundle.
 *
 * The hash is taken over `core` alone. `presentation` is attached afterwards, so
 * two runs on two machines at two times produce the SAME identity for the same
 * evidence - which is the whole reproducibility promise, and is testable only
 * because the timestamp is outside the hash.
 */

export interface BundleDraft {
  readonly core: Omit<EvidenceCore, 'producer'> & {
    readonly producer: Omit<EvidenceCore['producer'], 'schemaVersion'>;
  };
  readonly presentation: EvidencePresentation;
}

export const buildBundle = (draft: BundleDraft): EvidenceBundle => {
  const core: EvidenceCore = {
    ...draft.core,
    producer: { ...draft.core.producer, schemaVersion: EVIDENCE_SCHEMA_VERSION },
  };
  return { core, presentation: draft.presentation, contentHash: hashCore(core) };
};

/**
 * Chain a bundle to its predecessor.
 *
 * This makes a SEQUENCE tamper-evident: removing a bundle from the middle breaks
 * the chain. It is not a blockchain and not a proof of anything; an operator who
 * controls the whole directory can rebuild the chain.
 */
export const chainTo = (draft: BundleDraft, previousBundleHash: string): BundleDraft => ({
  ...draft,
  core: { ...draft.core, previousBundleHash },
});
