import type { BlockTag } from './methods.js';
import type { QuorumResult } from './quorum.js';

/**
 * Finality capability and the pinned cut.
 *
 * Avalanche acceptance is final, so there is no confirmation-depth notion here:
 * waiting N more blocks proves nothing that acceptance did not already prove.
 * What does need establishing is whether a given endpoint actually answers from
 * accepted state, and that is a node configuration rather than a protocol
 * guarantee (docs/adr/0002-accepted-quorum-truth.md).
 */

export const ACCEPTED_STATE_EVIDENCE = [
  /** The endpoint answered a probe consistent with accepted-only state. */
  'probed-accepted-only',
  /** The endpoint advertised a finality tag and it behaved consistently. */
  'probed-finality-tag',
  /** Nothing could be established. Never treated as if it were accepted. */
  'unproven',
] as const;
export type AcceptedStateEvidence = (typeof ACCEPTED_STATE_EVIDENCE)[number];

export interface TagProbe {
  readonly tag: BlockTag;
  readonly supported: boolean;
  /** Height the tag resolved to, when it resolved at all. */
  readonly height?: bigint;
  readonly detail: string;
}

export interface EndpointCapability {
  readonly endpointId: string;
  readonly trustDomain: string;
  readonly probes: readonly TagProbe[];
  readonly acceptedStateEvidence: AcceptedStateEvidence;
  readonly archiveDepth: 'full' | 'pruned' | 'unknown';
  /** Deepest height the endpoint could actually serve historical state for. */
  readonly historicalStateFloor?: bigint;
}

/**
 * Decide which block reference a comparative read may use.
 *
 * An unsupported or unproven tag never silently degrades to `latest`. The
 * official C-Chain API reference does not document `safe` or `finalized`, so
 * their behaviour is established per endpoint or not claimed at all.
 */
export type FinalityDecision =
  | {
      readonly ok: true;
      readonly basis: 'accepted-latest' | 'finalized-tag';
      readonly evidence: AcceptedStateEvidence;
    }
  | { readonly ok: false; readonly reason: string };

export const decideFinalityBasis = (capability: EndpointCapability): FinalityDecision => {
  const finalized = capability.probes.find((p) => p.tag === 'finalized' && p.supported);
  if (finalized !== undefined && capability.acceptedStateEvidence === 'probed-finality-tag') {
    return { ok: true, basis: 'finalized-tag', evidence: capability.acceptedStateEvidence };
  }
  if (capability.acceptedStateEvidence === 'probed-accepted-only') {
    // At AvalancheGo defaults `allow-unfinalized-queries` is false, so `latest`
    // is already the last accepted block. That default was verified, and the
    // probe confirms this endpoint behaves that way.
    return { ok: true, basis: 'accepted-latest', evidence: capability.acceptedStateEvidence };
  }
  return {
    ok: false,
    reason:
      'the endpoint did not establish that it answers from accepted state, and no finality tag was proven; ' +
      'falling back to latest would assert a guarantee that was not shown',
  };
};

/**
 * The pinned cut for one evaluation.
 *
 * Every state, log, code and storage read in an evaluation is taken at this cut.
 * Comparing two chains at two different moments is the failure this product
 * exists to catch, so `latest` is not a field here.
 */
export interface PinnedBlockContext {
  readonly blockchainId: string;
  readonly evmChainId: bigint;
  readonly networkId: bigint;
  readonly blockNumber: bigint;
  /** Hash exactly as the endpoints returned it, never recomputed locally. */
  readonly blockHash: string;
  readonly basis: 'accepted-latest' | 'finalized-tag';
  readonly evidence: AcceptedStateEvidence;
  readonly agreeingTrustDomains: readonly string[];
  readonly agreeingProviderGroups: readonly string[];
  readonly agreeingEndpointIds: readonly string[];
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
  /** Anything the caller could not establish, carried into the evidence bundle. */
  readonly degraded: readonly string[];
}

export type PinResult =
  | { readonly ok: true; readonly context: PinnedBlockContext }
  | { readonly ok: false; readonly reason: string; readonly quorum: QuorumResult };

export interface PinInput {
  readonly quorum: QuorumResult;
  readonly identity: { blockchainId: string; evmChainId: bigint; networkId: bigint };
  readonly capability: FinalityDecision;
  readonly observedAtMs: number;
  readonly freshnessMs: number;
}

/**
 * Build a pinned context, or explain why one cannot exist.
 *
 * There is no partial success: without agreement on a hash and without
 * established finality semantics there is nothing to pin, and an evaluation
 * without a pin cannot produce a comparable result.
 */
export const buildPinnedContext = (input: PinInput): PinResult => {
  if (input.quorum.outcome !== 'agreed') {
    return {
      ok: false,
      reason: `witness quorum did not agree (${input.quorum.outcome})`,
      quorum: input.quorum,
    };
  }
  const { height, blockHash } = input.quorum;
  if (height === undefined || blockHash === undefined) {
    return {
      ok: false,
      reason: 'quorum reported agreement without a height and hash',
      quorum: input.quorum,
    };
  }
  if (!input.capability.ok) {
    return { ok: false, reason: input.capability.reason, quorum: input.quorum };
  }

  return {
    ok: true,
    context: {
      blockchainId: input.identity.blockchainId.toLowerCase(),
      evmChainId: input.identity.evmChainId,
      networkId: input.identity.networkId,
      blockNumber: height,
      blockHash: blockHash.toLowerCase(),
      basis: input.capability.basis,
      evidence: input.capability.evidence,
      agreeingTrustDomains: input.quorum.agreeingTrustDomains,
      agreeingProviderGroups: input.quorum.agreeingProviderGroups,
      agreeingEndpointIds: input.quorum.agreeingEndpointIds,
      observedAtMs: input.observedAtMs,
      expiresAtMs: input.observedAtMs + input.freshnessMs,
      degraded: input.quorum.degraded,
    },
  };
};

export const isExpired = (context: PinnedBlockContext, nowMs: number): boolean =>
  nowMs > context.expiresAtMs;

/**
 * Hash-before / read / hash-after.
 *
 * Used when an endpoint cannot pin `eth_call` to a block hash. If the hash at
 * the pinned height changed across the read, the value may have come from a
 * different chain view and is discarded rather than reported.
 */
export type GuardedRead<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: 'hash-changed-during-read';
      readonly before: string;
      readonly after: string;
    };

export const guardRead = <T>(before: string, value: T, after: string): GuardedRead<T> =>
  before.toLowerCase() === after.toLowerCase()
    ? { ok: true, value }
    : { ok: false, reason: 'hash-changed-during-read', before, after };

/**
 * A block hash is only ever taken from the endpoint.
 *
 * Avalanche adds header fields that standard geth structures do not carry, so a
 * locally reconstructed hash would not be the chain's hash. This exists as a
 * function so the rule has a name and a test rather than only a comment
 * (docs/PROTOCOL_SOURCE_LOCK.md section 6).
 */
export const reconstructBlockHashLocally = (): never => {
  throw new Error(
    'a C-Chain block hash is never reconstructed from geth header fields; Avalanche carries additional ' +
      'header semantics, so the hash returned by the node is the one quorum is built on',
  );
};

/**
 * Confirmation depth is not finality evidence on Avalanche.
 *
 * Named and thrown for the same reason: the mistake is easy to make and cheap
 * to forbid outright.
 */
export const finalityFromConfirmationDepth = (_depth: number): never => {
  throw new Error(
    'confirmation depth is not evidence of Avalanche finality; acceptance is final, so waiting for ' +
      'additional blocks adds no guarantee',
  );
};
