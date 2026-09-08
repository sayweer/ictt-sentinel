import type { EvidenceBundle } from '@ictt-sentinel/evidence';
import { assertSecretFree } from '@ictt-sentinel/evidence';

/**
 * What may leave the operator's machine.
 *
 * The hosted plane is optional and this is the switch that makes it optional in
 * a checkable way. The default is the most restrictive level, and raising it is
 * an explicit operator act - never a consequence of enabling the hosted plane,
 * and never a default that a busy operator discovers after the fact
 * (docs/ARCHITECTURE.md 2).
 *
 *   local-only          nothing leaves. Evaluation, evidence and alerting all
 *                       still work; the hosted plane simply gets nothing.
 *   sanitized-metadata  verdict, reason codes, freshness and the evidence
 *                       content hash. No chain data, no addresses, no payloads.
 *   approved-full       the complete evidence bundle, because the operator
 *                       decided an auditor needs it.
 */

export const SHARING_LEVELS = ['local-only', 'sanitized-metadata', 'approved-full'] as const;
export type SharingLevel = (typeof SHARING_LEVELS)[number];

/** The default is not a preference; it is the safe end of the range. */
export const DEFAULT_SHARING_LEVEL: SharingLevel = 'local-only';

export const isSharingLevel = (v: unknown): v is SharingLevel =>
  typeof v === 'string' && (SHARING_LEVELS as readonly string[]).includes(v);

export interface SanitizedMetadata {
  readonly deploymentId: string;
  readonly evidenceHash: string;
  readonly schemaVersion: string;
  readonly protocolStatus: string;
  readonly dataStatus: string;
  readonly claimMode: string;
  readonly coverage: string;
  readonly reasonCodes: readonly string[];
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly fresh: boolean;
  /** Counts, not identities: enough to see scope, not enough to map a chain. */
  readonly chainCount: number;
  readonly ruleCount: number;
  readonly messageCount: number;
}

export type SharedEvidence =
  | { readonly level: 'local-only'; readonly body: null }
  | { readonly level: 'sanitized-metadata'; readonly body: SanitizedMetadata }
  | { readonly level: 'approved-full'; readonly body: EvidenceBundle };

/**
 * Project a bundle down to what the configured level permits.
 *
 * `local-only` returns nothing at all rather than an empty envelope, so a caller
 * that forgets to check the level sends `null` instead of leaking a shell of
 * real fields.
 */
export const project = (level: SharingLevel, bundle: EvidenceBundle): SharedEvidence => {
  switch (level) {
    case 'local-only':
      return { level, body: null };
    case 'sanitized-metadata': {
      const { core } = bundle;
      const body: SanitizedMetadata = {
        deploymentId: core.deploymentId,
        evidenceHash: bundle.contentHash,
        schemaVersion: core.producer.schemaVersion,
        protocolStatus: core.verdict.protocolStatus,
        dataStatus: core.verdict.dataStatus,
        claimMode: core.verdict.claimMode,
        coverage: core.verdict.coverage,
        reasonCodes: core.verdict.reasonCodes,
        observedAt: core.completeness.observedAt,
        expiresAt: core.completeness.expiresAt,
        fresh: core.completeness.fresh,
        chainCount: core.chains.length,
        ruleCount: core.rules.length,
        messageCount: core.messages.length,
      };
      assertSecretFree(JSON.stringify(body));
      return { level, body };
    }
    case 'approved-full':
      // The bundle is already secret-free by construction and asserted on
      // export; re-checking here costs nothing and covers a hand-built bundle.
      assertSecretFree(JSON.stringify(bundle));
      return { level, body: bundle };
  }
};
