/**
 * The closed read-method allowlist.
 *
 * This is the only place in the product where a JSON-RPC method name exists as a
 * string. There is no `request(method, params)` surface: callers describe a
 * domain operation and this module maps it to one of the methods below.
 *
 * A generic passthrough would let the product reach any method the operator's
 * credential can reach, which quietly turns a read-only tool into whatever the
 * endpoint allows (docs/SECURITY.md section 2).
 */

/** Every method this product may ever send. Nothing else is reachable. */
export const ALLOWED_METHODS = [
  // chain identity and capability
  'eth_chainId',
  'net_version',
  // blocks
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  // logs and receipts
  'eth_getLogs',
  'eth_getTransactionReceipt',
  // state
  'eth_call',
  'eth_getCode',
  'eth_getStorageAt',
] as const;

export type AllowedMethod = (typeof ALLOWED_METHODS)[number];

const ALLOWED = new Set<string>(ALLOWED_METHODS);

/**
 * Method families that must never be sent, listed so the ban is explicit and
 * testable rather than implied by the allowlist's absence.
 *
 * `debug_` and `trace_` are excluded not because they write, but because their
 * results are node-implementation specific and would become an unpinned source
 * of truth.
 */
export const FORBIDDEN_METHOD_PREFIXES = [
  'eth_send',
  'eth_sign',
  'personal_',
  'wallet_',
  'admin_',
  'engine_',
  'miner_',
  'txpool_',
  'debug_',
  'trace_',
  'evm_',
  'hardhat_',
  'anvil_',
] as const;

export const FORBIDDEN_METHODS = [
  'eth_sendTransaction',
  'eth_sendRawTransaction',
  'eth_sign',
  'eth_signTransaction',
  'eth_signTypedData',
  'personal_sign',
  'personal_unlockAccount',
  'wallet_addEthereumChain',
  'admin_addPeer',
  'engine_newPayloadV1',
  'miner_start',
  'debug_traceTransaction',
] as const;

export const isAllowedMethod = (method: string): method is AllowedMethod => ALLOWED.has(method);

export const isForbiddenMethod = (method: string): boolean =>
  FORBIDDEN_METHOD_PREFIXES.some((p) => method.startsWith(p)) ||
  (FORBIDDEN_METHODS as readonly string[]).includes(method);

/**
 * Guard applied immediately before a request leaves this package.
 *
 * The allowlist is a closed set, so this can only fire if someone added a method
 * without adding it here. Failing loudly beats sending it.
 */
export const assertSendable = (method: string): AllowedMethod => {
  if (isForbiddenMethod(method)) {
    throw new Error(`refusing to send "${method}": this product never writes to a chain`);
  }
  if (!isAllowedMethod(method)) {
    throw new Error(`refusing to send "${method}": not on the read-only allowlist`);
  }
  return method;
};

/**
 * Block references this package will use.
 *
 * `latest` is included because, at AvalancheGo defaults, it already means the
 * last accepted block; `allow-unfinalized-queries` is false by default. That is
 * a node configuration, not a protocol guarantee, so an endpoint's actual
 * behaviour is probed rather than assumed (docs/PROTOCOL_SOURCE_LOCK.md section 6).
 *
 * `safe` and `finalized` appear here only as probe targets. The official C-Chain
 * API reference does not document them, so support is established per endpoint
 * and an unproven tag never silently degrades to `latest`.
 */
export const BLOCK_TAGS = ['latest', 'safe', 'finalized', 'earliest'] as const;
export type BlockTag = (typeof BLOCK_TAGS)[number];

/**
 * A block reference. Comparative reads must use a pinned number or hash; a tag
 * is only for probing and for establishing the pin in the first place.
 */
export type BlockRef =
  | { readonly kind: 'tag'; readonly tag: BlockTag }
  | { readonly kind: 'number'; readonly number: bigint }
  | { readonly kind: 'hash'; readonly hash: string };

export const toBlockParam = (ref: BlockRef): string => {
  switch (ref.kind) {
    case 'tag':
      return ref.tag;
    case 'number':
      return `0x${ref.number.toString(16)}`;
    case 'hash':
      return ref.hash;
  }
};
