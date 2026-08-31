import { z } from 'zod';
import {
  zBlockNumber,
  zBlockchainId,
  zBytes32,
  zDigest,
  zEvmAddress,
  zEvmChainId,
  zIsoTimestamp,
  zLabel,
  zNetworkId,
  zSecretRef,
  zSlug,
} from './primitives.js';

/**
 * ICTTDeployment manifest, apiVersion `sentinel.ictt/v1alpha1`.
 *
 * The manifest is the approved statement of what a deployment is supposed to
 * be. Drift detection is only meaningful against a baseline a human signed off,
 * so this document is version controlled, reviewed, and carries no secret
 * values (docs/DATA_MODEL.md 3).
 */

export const MANIFEST_KIND = 'ICTTDeployment' as const;

/** apiVersions this build understands. An unknown one fails closed. */
export const SUPPORTED_MANIFEST_API_VERSIONS = ['sentinel.ictt/v1alpha1'] as const;

/**
 * Assurance scope. V0 verifies accepted state agreed by a provider quorum.
 * It does not independently re-verify ICM BLS aggregate signatures or the Warp
 * predicate against a historical P-Chain validator set, so that claim has no
 * spelling here (docs/adr/0004-icm-assurance-scope.md).
 */
export const zAssuranceMode = z.literal('ACCEPTED_STATE_ASSURANCE');

/**
 * Finality is a named semantic, never a confirmation depth. Avalanche
 * acceptance is final; "wait N blocks" would attach a guarantee to a number
 * that does not carry one (docs/INVARIANTS.md 10).
 *
 * `settled-quorum` is reserved for the ACP-194 world, where acceptance and
 * execution separate. It is declared but not yet implemented, so selecting it
 * is refused rather than silently treated as `accepted-quorum`.
 */
export const zFinalityMode = z.enum(['accepted-quorum', 'settled-quorum']);

export const zFinality = z.strictObject({
  mode: zFinalityMode,
  /**
   * What the operator asserts the endpoints provide. `allow-unfinalized-queries`
   * defaults to false on C-Chain, meaning `latest` is already the accepted
   * block; an endpoint configured otherwise cannot back an accepted-state claim.
   */
  acceptedStateQueries: z.enum(['accepted-only', 'may-include-unfinalized', 'unknown']),
  maxLagSeconds: z.int().positive().max(86_400),
});

/**
 * An RPC endpoint. Carries no URL: only an id, an independence claim and the
 * name of the variable that holds the address.
 */
export const zEndpoint = z.strictObject({
  id: zSlug,
  /**
   * The independence unit. Quorum counts distinct trustDomains, never URLs:
   * two hostnames in front of one upstream are one witness
   * (docs/INVARIANTS.md 9).
   */
  trustDomain: zSlug,
  /** Operational grouping, e.g. a vendor account. May repeat within a domain. */
  providerGroup: zSlug,
  role: z.enum(['primary', 'secondary', 'archive']),
  secretRef: zSecretRef,
  archiveDepth: z.enum(['full', 'pruned', 'unknown']).default('unknown'),
});

export const zProxyExpectation = z.strictObject({
  kind: z.enum(['none', 'erc1967', 'transparent', 'beacon']),
  implementation: zEvmAddress.optional(),
  admin: zEvmAddress.optional(),
});

/**
 * What the contract is expected to be. An unrecognised fingerprint is UNKNOWN,
 * never a silent pass (docs/SUPPORT_MATRIX.md 8).
 */
export const zFingerprintExpectation = z.strictObject({
  runtimeCodeHash: zBytes32.optional(),
  allowedImplementationHashes: z.array(zBytes32).max(16).default([]),
  sourceRef: z
    .strictObject({
      repository: z.enum(['ava-labs/icm-services']),
      commitSha: z.string().regex(/^[0-9a-f]{40}$/, 'must be a full 40-character commit SHA'),
      path: z.string().min(1).max(300),
    })
    .optional(),
  onUnknownFingerprint: z.literal('fail-closed').default('fail-closed'),
});

export const zChainIdentity = z.strictObject({
  /** Avalanche ICM identity. A separate field from evmChainId, and never equal. */
  blockchainId: zBlockchainId,
  evmChainId: zEvmChainId,
  networkId: zNetworkId,
  subnetId: zBytes32,
  /** Either the genesis hash or an operator-attested checkpoint must be present. */
  genesisHash: zBytes32.optional(),
  trustedCheckpoint: z
    .strictObject({
      blockNumber: zBlockNumber,
      blockHash: zBytes32,
      attestedBy: zLabel,
      attestedAt: zIsoTimestamp,
    })
    .optional(),
  finality: zFinality,
  endpoints: z.array(zEndpoint).min(1).max(8),
  quorum: z.strictObject({
    /** Minimum number of distinct trustDomains that must agree on a pinned block. */
    independentTrustDomains: z.int().min(2).max(8),
  }),
});

export const zTeleporter = z.strictObject({
  /**
   * Source family. `teleporterV2` is a separate, unaudited source tree and is
   * not accepted here; a registry protocol version says nothing about which
   * family is deployed (docs/PROTOCOL_SOURCE_LOCK.md 4).
   */
  family: z.literal('teleporter'),
  registryAddress: zEvmAddress,
  messengerAddress: zEvmAddress,
  minimumProtocolVersion: z.int().min(1).max(255),
});

export const zTokenHome = z.strictObject({
  role: z.enum(['erc20-token-home', 'native-token-home']),
  address: zEvmAddress,
  tokenAddress: zEvmAddress,
  deploymentBlock: zBlockNumber,
  proxy: zProxyExpectation,
  fingerprint: zFingerprintExpectation,
});

export const zTokenRemote = z.strictObject({
  role: z.enum(['erc20-token-remote', 'native-token-remote']),
  address: zEvmAddress,
  deploymentBlock: zBlockNumber,
  expectedDecimals: z.int().min(0).max(77),
  proxy: zProxyExpectation,
  fingerprint: zFingerprintExpectation,
});

export const zHome = z.strictObject({
  name: zSlug,
  chain: zChainIdentity,
  tokenHome: zTokenHome,
  teleporter: zTeleporter,
});

export const zRemote = z.strictObject({
  name: zSlug,
  chain: zChainIdentity,
  tokenRemote: zTokenRemote,
  teleporter: zTeleporter,
});

/**
 * Census of registered remotes.
 *
 * Scope is bounded to one TokenHome's own `RemoteRegistered` history from its
 * deployment block. The product does not, and must not, claim to enumerate
 * every ICTT deployment on Avalanche.
 */
export const zCensus = z.strictObject({
  scope: z.literal('registered-remotes-of-this-token-home'),
  source: z.literal('RemoteRegistered'),
  fromBlock: zBlockNumber,
  completeness: z.enum(['complete-from-deployment-block', 'partial', 'unknown']),
});

/**
 * How each baseline field is treated when observation and manifest disagree.
 *   LOCKED          - any drift is a violation
 *   APPROVED_CHANGE - drift is allowed only with a recorded approval
 *   OBSERVE_ONLY    - drift is reported, never a violation
 */
export const zFieldPolicyMode = z.enum(['LOCKED', 'APPROVED_CHANGE', 'OBSERVE_ONLY']);

const BASELINE_FIELDS = [
  'home.chain.blockchainId',
  'home.chain.evmChainId',
  'home.chain.genesisHash',
  'home.tokenHome.address',
  'home.tokenHome.tokenAddress',
  'home.tokenHome.proxy.implementation',
  'home.tokenHome.fingerprint.runtimeCodeHash',
  'home.teleporter.registryAddress',
  'home.teleporter.messengerAddress',
  'home.teleporter.minimumProtocolVersion',
  'remotes[].chain.blockchainId',
  'remotes[].tokenRemote.address',
  'remotes[].tokenRemote.expectedDecimals',
  'remotes[].tokenRemote.proxy.implementation',
  'remotes[].tokenRemote.fingerprint.runtimeCodeHash',
  'census.completeness',
] as const;

export const zFieldPolicies = z
  .strictObject(
    Object.fromEntries(BASELINE_FIELDS.map((f) => [f, zFieldPolicyMode])) as Record<
      (typeof BASELINE_FIELDS)[number],
      typeof zFieldPolicyMode
    >,
  )
  .describe('policy mode for every baseline field');

/**
 * Discovery output. Never a baseline on its own: a permissionlessly registered
 * remote is a candidate, not something trusted (docs/PRODUCT.md 6).
 */
export const zCandidateBaseline = z.strictObject({
  state: z.literal('candidate'),
  discovery: z.strictObject({
    discoveredAt: zIsoTimestamp,
    tool: zLabel,
    atBlock: zBlockNumber,
  }),
  fieldPolicies: zFieldPolicies,
});

export const zApprovedBaseline = z.strictObject({
  state: z.literal('approved'),
  approval: z.strictObject({
    approvedBy: zLabel,
    approvedAt: zIsoTimestamp,
    /** Digest of the reviewed candidate, so approval names what was read. */
    reviewedDigest: zDigest,
    note: zLabel.optional(),
  }),
  fieldPolicies: zFieldPolicies,
});

export const zBaseline = z.discriminatedUnion('state', [zCandidateBaseline, zApprovedBaseline]);

export const zTokenMode = z.enum(['canonical-erc20', 'native']);

export const zSpec = z.strictObject({
  assuranceMode: zAssuranceMode,
  // Named `asset`, not `token`: "token" also means a credential, and the
  // inline-secret scan bans that key outright. The security rule stays broad
  // and the domain field gets the unambiguous name.
  asset: z.strictObject({
    mode: zTokenMode,
    homeDecimals: z.int().min(0).max(77),
  }),
  home: zHome,
  remotes: z.array(zRemote).min(1).max(32),
  census: zCensus,
  baseline: zBaseline,
});

export const zManifest = z.strictObject({
  apiVersion: z.enum(SUPPORTED_MANIFEST_API_VERSIONS),
  kind: z.literal(MANIFEST_KIND),
  metadata: z.strictObject({
    name: zSlug,
    operator: zLabel,
    description: zLabel.optional(),
  }),
  spec: zSpec,
});

export type Manifest = z.infer<typeof zManifest>;
export type ManifestSpec = z.infer<typeof zSpec>;
export type ChainIdentity = z.infer<typeof zChainIdentity>;
export type Endpoint = z.infer<typeof zEndpoint>;
export type CandidateBaseline = z.infer<typeof zCandidateBaseline>;
export type ApprovedBaseline = z.infer<typeof zApprovedBaseline>;
export type FieldPolicyMode = z.infer<typeof zFieldPolicyMode>;
export { BASELINE_FIELDS };
