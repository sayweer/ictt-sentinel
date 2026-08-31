import { keccak_256 } from '@noble/hashes/sha3.js';
import { toBlockParam, type AllowedMethod, type BlockRef } from './methods.js';
import type { RpcRequest } from './transport.js';

/**
 * Domain operations, mapped to the read-method allowlist.
 *
 * Callers express what they want to know, not which JSON-RPC method carries it.
 * That keeps method names in one place and makes it impossible to reach a method
 * simply by naming it.
 */

const toHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

const selector = (signature: string): string =>
  toHex(keccak_256(new TextEncoder().encode(signature))).slice(0, 10);

/**
 * Precompile addresses and view signatures, taken from the pinned source rather
 * than from memory:
 *   icm-contracts/avalanche/subnet-evm/IWarpMessenger.sol
 *   icm-contracts/avalanche/subnet-evm/IAllowList.sol
 *   @ 8fef6ef73767f4497a72d8348a0774a262e0c535
 *
 * Only `view` functions appear here. `sendWarpMessage`, `mintNativeCoin` and the
 * allow-list setters exist in those interfaces and are deliberately absent.
 */
export const PRECOMPILES = {
  /** IWarpMessenger, as referenced by the pinned ICTT contracts. */
  warpMessenger: '0x0200000000000000000000000000000000000005',
  /** INativeMinter, likewise. Read-only use: allow-list role queries. */
  nativeMinter: '0x0200000000000000000000000000000000000001',
} as const;

/**
 * `getBlockchainID()` returns the snow.Context BlockchainID: the hash of the
 * transaction that created the chain on the P-Chain. The interface NatSpec is
 * explicit that it "is not related to the Ethereum ChainID", which is why the
 * two are separate fields everywhere in this product.
 */
export const WARP_GET_BLOCKCHAIN_ID_SIG = 'getBlockchainID()';
export const ALLOWLIST_READ_SIG = 'readAllowList(address)';

export const warpGetBlockchainIdCalldata = (): string => selector(WARP_GET_BLOCKCHAIN_ID_SIG);

export const readAllowListCalldata = (account: string): string => {
  const body = account.startsWith('0x') ? account.slice(2) : account;
  if (!/^[0-9a-fA-F]{40}$/.test(body))
    throw new TypeError('readAllowList expects a 20-byte address');
  return `${selector(ALLOWLIST_READ_SIG)}${body.toLowerCase().padStart(64, '0')}`;
};

/**
 * The operations this product may perform. Adding one is a deliberate edit here
 * plus an entry on the method allowlist.
 */
export type ReadOperation =
  | { readonly op: 'evm-chain-id' }
  | { readonly op: 'network-version' }
  | { readonly op: 'head-block-number' }
  | { readonly op: 'block-by-ref'; readonly ref: BlockRef; readonly fullTransactions: false }
  | {
      readonly op: 'logs';
      readonly fromBlock: bigint;
      readonly toBlock: bigint;
      readonly address?: string;
      readonly topics?: readonly (string | null)[];
    }
  | { readonly op: 'transaction-receipt'; readonly txHash: string }
  | { readonly op: 'call'; readonly to: string; readonly data: string; readonly at: BlockRef }
  | { readonly op: 'code'; readonly address: string; readonly at: BlockRef }
  | {
      readonly op: 'storage-slot';
      readonly address: string;
      readonly slot: string;
      readonly at: BlockRef;
    }
  /** Source-locked precompile reads. */
  | { readonly op: 'warp-blockchain-id'; readonly at: BlockRef }
  | { readonly op: 'native-minter-role'; readonly account: string; readonly at: BlockRef };

/**
 * Build the request for an operation.
 *
 * `eth_call` calldata is produced for reads only. There is no code path that
 * builds a transaction envelope, and no client here can sign or send one.
 */
export const buildRequest = (operation: ReadOperation): RpcRequest => {
  const method = (m: AllowedMethod, params: readonly unknown[]): RpcRequest => ({
    method: m,
    params,
  });

  switch (operation.op) {
    case 'evm-chain-id':
      return method('eth_chainId', []);
    case 'network-version':
      return method('net_version', []);
    case 'head-block-number':
      return method('eth_blockNumber', []);
    case 'block-by-ref':
      return operation.ref.kind === 'hash'
        ? method('eth_getBlockByHash', [operation.ref.hash, false])
        : method('eth_getBlockByNumber', [toBlockParam(operation.ref), false]);
    case 'logs': {
      const filter: Record<string, unknown> = {
        fromBlock: `0x${operation.fromBlock.toString(16)}`,
        toBlock: `0x${operation.toBlock.toString(16)}`,
      };
      if (operation.address !== undefined) filter['address'] = operation.address;
      if (operation.topics !== undefined) filter['topics'] = operation.topics;
      return method('eth_getLogs', [filter]);
    }
    case 'transaction-receipt':
      return method('eth_getTransactionReceipt', [operation.txHash]);
    case 'call':
      return method('eth_call', [
        { to: operation.to, data: operation.data },
        toBlockParam(operation.at),
      ]);
    case 'code':
      return method('eth_getCode', [operation.address, toBlockParam(operation.at)]);
    case 'storage-slot':
      return method('eth_getStorageAt', [
        operation.address,
        operation.slot,
        toBlockParam(operation.at),
      ]);
    case 'warp-blockchain-id':
      return method('eth_call', [
        { to: PRECOMPILES.warpMessenger, data: warpGetBlockchainIdCalldata() },
        toBlockParam(operation.at),
      ]);
    case 'native-minter-role':
      return method('eth_call', [
        { to: PRECOMPILES.nativeMinter, data: readAllowListCalldata(operation.account) },
        toBlockParam(operation.at),
      ]);
  }
};

/**
 * Log range guard.
 *
 * An unbounded range is refused rather than trimmed: silently narrowing a window
 * would return fewer events than asked for, and "fewer events" is
 * indistinguishable from "no events happened".
 */
export const assertLogRange = (
  fromBlock: bigint,
  toBlock: bigint,
  maxRangeBlocks: number,
): void => {
  if (toBlock < fromBlock) throw new RangeError('log range ends before it starts');
  const span = toBlock - fromBlock + 1n;
  if (span > BigInt(maxRangeBlocks)) {
    throw new RangeError(
      `log range of ${span.toString()} blocks exceeds the limit of ${String(maxRangeBlocks)}; split the scan instead of widening the limit`,
    );
  }
};
