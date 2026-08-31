/**
 * RPC fault taxonomy.
 *
 * The distinction that matters is not "did it work" but "may this become a
 * verdict". A timeout and a wrong chain id both fail, but only one of them is
 * worth retrying, and neither may quietly become a green result.
 */

export const RPC_FAULTS = [
  // transient: retrying the same request may succeed
  'timeout',
  'rate-limited',
  'transport',
  'server-error',
  // permanent for this endpoint: retrying changes nothing
  'unsupported-method',
  'unsupported-block-tag',
  'pruned-history',
  'invalid-response',
  'response-too-large',
  'response-too-deep',
  // security or integrity: never retried, never downgraded
  'insecure-url',
  'redirect-refused',
  'host-not-allowed',
  'forbidden-method',
  // identity and agreement
  'wrong-chain',
  'stale-head',
  'future-head',
  'witness-disagreement',
  'insufficient-witnesses',
  'integrity-conflict',
] as const;
export type RpcFault = (typeof RPC_FAULTS)[number];

/** Faults where the same request, unchanged, may succeed later. */
export const TRANSIENT_FAULTS: readonly RpcFault[] = [
  'timeout',
  'rate-limited',
  'transport',
  'server-error',
];

export const isTransient = (fault: RpcFault): boolean => TRANSIENT_FAULTS.includes(fault);

/**
 * Faults that must never be retried or worked around, because doing so would
 * either weaken a security boundary or paper over a contradiction.
 */
export const NEVER_RETRY: readonly RpcFault[] = [
  'insecure-url',
  'redirect-refused',
  'host-not-allowed',
  'forbidden-method',
  'integrity-conflict',
  'wrong-chain',
];

export interface RpcFaultDetail {
  readonly fault: RpcFault;
  /** Endpoint identifier, never a URL (docs/SECURITY.md section 3). */
  readonly endpointId: string;
  readonly trustDomain: string;
  readonly message: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
}

export class RpcError extends Error {
  readonly detail: RpcFaultDetail;

  constructor(detail: RpcFaultDetail) {
    super(`[${detail.fault}] ${detail.endpointId}: ${detail.message}`);
    this.name = 'RpcError';
    this.detail = detail;
  }

  get transient(): boolean {
    return isTransient(this.detail.fault);
  }
}

/**
 * A chain-safety incident.
 *
 * Raised when an endpoint reports a different hash for a height this product
 * already recorded as accepted. On Avalanche, acceptance is final, so this is
 * not a reorg and must not be rolled back as one: either an endpoint is lying,
 * is serving a different chain, or something is badly wrong. The recorded
 * evidence is preserved and the evaluation stops
 * (docs/adr/0002-accepted-quorum-truth.md).
 */
export class RpcIntegrityConflict extends Error {
  readonly code = 'RPC_INTEGRITY_CONFLICT' as const;
  readonly blockNumber: bigint;
  readonly recordedHash: string;
  readonly observedHash: string;
  readonly endpointId: string;
  readonly trustDomain: string;

  constructor(args: {
    blockNumber: bigint;
    recordedHash: string;
    observedHash: string;
    endpointId: string;
    trustDomain: string;
  }) {
    super(
      `RPC_INTEGRITY_CONFLICT at height ${args.blockNumber.toString()}: ` +
        `endpoint ${args.endpointId} reports a different hash for a height already recorded as accepted. ` +
        'Avalanche acceptance is final, so this is not a reorg and is not rolled back.',
    );
    this.name = 'RpcIntegrityConflict';
    this.blockNumber = args.blockNumber;
    this.recordedHash = args.recordedHash;
    this.observedHash = args.observedHash;
    this.endpointId = args.endpointId;
    this.trustDomain = args.trustDomain;
  }
}

/** Classify an HTTP status into a fault. Anything unrecognised is not transient. */
export const faultForStatus = (status: number): RpcFault => {
  if (status === 429) return 'rate-limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'server-error';
  return 'transport';
};

/** JSON-RPC error codes that mean the endpoint cannot serve this, ever. */
export const faultForJsonRpcError = (code: number, message: string): RpcFault => {
  // -32601 method not found; -32004 method not supported
  if (code === -32601 || code === -32004) return 'unsupported-method';
  if (/pruned|missing trie|not available|state.*unavailable/i.test(message))
    return 'pruned-history';
  if (/unknown block|header not found|invalid block/i.test(message)) return 'unsupported-block-tag';
  if (code === -32005 || /limit exceeded|too many|rate/i.test(message)) return 'rate-limited';
  if (code <= -32000 && code > -32100) return 'server-error';
  return 'invalid-response';
};
