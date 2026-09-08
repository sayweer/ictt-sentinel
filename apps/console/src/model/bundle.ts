import type { EvidenceBundle } from '@ictt-sentinel/evidence';
import type { AssetMode, ClaimMode, CoverageState } from './claim.js';
import { ASSET_MODES, CLAIM_MODES, COVERAGE_STATES } from './claim.js';

/**
 * Projections of an evidence bundle into what a screen needs.
 *
 * Read-only and total: every accessor tolerates a bundle produced by a different
 * build, because the console must render an old bundle rather than blank the
 * page. Unknown enum values collapse to the fail-closed member, never to the
 * healthy one.
 *
 * The console never re-derives a verdict from these fields. The verdict is what
 * the bundle records; this module only decides how to show it.
 */

const known = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

export interface ChainPanel {
  readonly blockchainId: string;
  readonly evmChainId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly finalityBasis: string;
  readonly acceptanceEvidence: string;
}

export const chainPanels = (bundle: EvidenceBundle): readonly ChainPanel[] =>
  bundle.core.chains.map((c) => ({
    blockchainId: c.blockchainId,
    evmChainId: c.evmChainId,
    blockNumber: c.blockNumber,
    blockHash: c.blockHash,
    finalityBasis: c.finalityBasis,
    acceptanceEvidence: c.acceptanceEvidence,
  }));

export interface FingerprintPanel {
  readonly role: string;
  readonly blockchainId: string;
  readonly address: string;
  readonly runtimeCodeHash: string;
  readonly proxy: string;
  readonly recognised: boolean;
}

export const fingerprintPanels = (bundle: EvidenceBundle): readonly FingerprintPanel[] =>
  bundle.core.fingerprints.map((f) => ({
    role: f.role,
    blockchainId: f.blockchainId,
    address: f.address,
    runtimeCodeHash: f.runtimeCodeHash,
    proxy:
      f.implementationAddress === null
        ? 'not a proxy'
        : `implementation ${f.implementationAddress}`,
    recognised: f.recognised,
  }));

export interface QuorumPanel {
  readonly independentGroups: number;
  readonly requiredGroups: number;
  readonly satisfied: boolean;
  readonly note: string;
  readonly witnesses: readonly {
    readonly endpointId: string;
    readonly providerGroup: string;
    readonly trustDomain: string;
    readonly agreed: boolean;
  }[];
  /** True when at least one witness disagreed on a pinned block hash. */
  readonly divergent: boolean;
}

export const quorumPanel = (bundle: EvidenceBundle): QuorumPanel => {
  const q = bundle.core.quorum;
  return {
    independentGroups: q.independentGroups,
    requiredGroups: q.requiredGroups,
    satisfied: q.independentGroups >= q.requiredGroups,
    note: q.note,
    witnesses: q.votes.map((v) => ({
      endpointId: v.endpointId,
      providerGroup: v.providerGroup,
      trustDomain: v.trustDomain,
      agreed: v.agreed,
    })),
    divergent: q.votes.some((v) => !v.agreed),
  };
};

export interface CensusPanel {
  readonly completeness: string;
  readonly registered: readonly string[];
  /** Remotes the census knows about but could not observe. Never netted to zero. */
  readonly missing: readonly string[];
  readonly withoutRpc: readonly string[];
  readonly complete: boolean;
}

export const censusPanel = (bundle: EvidenceBundle): CensusPanel => {
  const c = bundle.core.census;
  return {
    completeness: c.completeness,
    registered: c.registeredRemotes,
    missing: c.missingRemotes,
    withoutRpc: c.remotesWithoutRpc,
    complete: c.missingRemotes.length === 0 && c.remotesWithoutRpc.length === 0,
  };
};

export interface RulePanel {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly result: string;
  readonly reasonCodes: readonly string[];
  readonly unit: string;
  /** Decimal strings throughout. Nothing here is ever parsed into a number. */
  readonly inputs: readonly (readonly [string, string])[];
  readonly intermediates: readonly (readonly [string, string])[];
}

export const rulePanels = (bundle: EvidenceBundle): readonly RulePanel[] =>
  bundle.core.rules.map((r) => ({
    ruleId: r.ruleId,
    ruleVersion: r.ruleVersion,
    result: r.result,
    reasonCodes: r.reasonCodes,
    unit: r.unit,
    inputs: Object.entries(r.inputs).sort(([a], [b]) => a.localeCompare(b)),
    intermediates: Object.entries(r.intermediates).sort(([a], [b]) => a.localeCompare(b)),
  }));

/**
 * The asset mode a bundle describes.
 *
 * Inferred from the fingerprint roles rather than guessed from the claim mode: a
 * native remote is native because of what is deployed, not because of what the
 * engine concluded about it. Unknown shapes fall to `canonical-erc20`'s stricter
 * vocabulary only when a native role is definitely absent.
 */
export const assetModeOf = (bundle: EvidenceBundle): AssetMode => {
  const native = bundle.core.fingerprints.some((f) => f.role.includes('native'));
  return known<AssetMode>(ASSET_MODES, native ? 'native' : 'canonical-erc20', 'canonical-erc20');
};

export interface VerdictPanel {
  readonly protocolStatus: string;
  readonly dataStatus: string;
  readonly claimMode: ClaimMode;
  readonly coverage: CoverageState;
  readonly reasonCodes: readonly string[];
  readonly criticalRuleIds: readonly string[];
  readonly unknownRuleIds: readonly string[];
}

export const verdictPanel = (bundle: EvidenceBundle): VerdictPanel => {
  const v = bundle.core.verdict;
  return {
    protocolStatus: v.protocolStatus,
    dataStatus: v.dataStatus,
    // A claim mode this build does not know is UNSUPPORTED, not EXACT.
    claimMode: known<ClaimMode>(CLAIM_MODES, v.claimMode, 'UNSUPPORTED'),
    coverage: known<CoverageState>(COVERAGE_STATES, v.coverage, 'UNVERIFIED'),
    reasonCodes: v.reasonCodes,
    criticalRuleIds: v.criticalRuleIds,
    unknownRuleIds: v.unknownRuleIds,
  };
};

export interface ProvenancePanel {
  readonly contentHash: string;
  readonly schemaVersion: string;
  readonly buildCommit: string;
  readonly artifactChecksum: string;
  readonly sourceCommit: string;
  readonly adapter: string;
  readonly manifestHash: string;
  readonly policyHash: string;
  readonly previousBundleHash: string | null;
  readonly assumptions: readonly string[];
  readonly exclusions: readonly string[];
  readonly nonGoals: readonly string[];
}

export const provenancePanel = (bundle: EvidenceBundle): ProvenancePanel => ({
  contentHash: bundle.contentHash,
  schemaVersion: bundle.core.producer.schemaVersion,
  buildCommit: bundle.core.producer.buildCommit,
  artifactChecksum: bundle.core.producer.artifactChecksum,
  sourceCommit: bundle.core.sourceLock.commitSha,
  adapter: `${bundle.core.sourceLock.adapterId} v${String(bundle.core.sourceLock.adapterVersion)}`,
  manifestHash: bundle.core.baseline.manifestHash,
  policyHash: bundle.core.baseline.policyHash,
  previousBundleHash: bundle.core.previousBundleHash,
  assumptions: bundle.core.assurance.assumptions,
  exclusions: bundle.core.assurance.exclusions,
  nonGoals: bundle.core.assurance.nonGoals,
});

/**
 * Bytes for the download.
 *
 * Re-serialised from the parsed bundle rather than passed through, so what an
 * operator saves is exactly what this page rendered. Verification happens
 * offline with `ictt-sentinel evidence verify --file`; the console does not
 * claim to have verified anything it displays.
 */
export const downloadPayload = (bundle: EvidenceBundle): string =>
  `${JSON.stringify(bundle, null, 2)}\n`;

export const OFFLINE_VERIFICATION_NOTE =
  'This console displays the verification status the API recorded. To verify independently, download the bundle and run `ictt-sentinel evidence verify --file <path>` on a machine you trust.' as const;
