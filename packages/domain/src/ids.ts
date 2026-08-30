import { type Brand, type Parsed, err, ok } from './brand.js';

/**
 * Avalanche ICM chain identity. NOT an EVM chainId and never the same value.
 * Canonical form here is the 32-byte hex encoding.
 */
export type BlockchainId = Brand<string, 'BlockchainId'>;

/** EVM `chainId`. A separate field from BlockchainId (docs/DATA_MODEL.md 2.4). */
export type EvmChainId = Brand<bigint, 'EvmChainId'>;

/** Genesis fingerprint of a chain, 32-byte hex. */
export type GenesisHash = Brand<string, 'GenesisHash'>;

/** EVM address, stored lowercase to make comparison total. */
export type EvmAddress = Brand<string, 'EvmAddress'>;

/** Block height. bigint so no 2^53 ceiling can silently truncate. */
export type BlockNumber = Brand<bigint, 'BlockNumber'>;

/** Block hash, 32-byte hex. Taken from the node; never recomputed locally. */
export type BlockHash = Brand<string, 'BlockHash'>;

/** Transaction hash, 32-byte hex. */
export type TransactionHash = Brand<string, 'TransactionHash'>;

/** Index of a log within a block. */
export type LogIndex = Brand<bigint, 'LogIndex'>;

/** Teleporter message id, 32-byte hex. */
export type MessageId = Brand<string, 'MessageId'>;

/**
 * Identifies an independent RPC provider family. Quorum counts distinct
 * ProviderGroupId values, never URLs (docs/INVARIANTS.md 9).
 */
export type ProviderGroupId = Brand<string, 'ProviderGroupId'>;

const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX20 = /^0x[0-9a-f]{40}$/;
const PROVIDER_GROUP = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

const parseHex =
  <T>(re: RegExp, label: string) =>
  (raw: string): Parsed<T> => {
    if (typeof raw !== 'string') return err(`${label}: not a string`);
    const lower = raw.toLowerCase();
    if (!re.test(lower)) return err(`${label}: expected ${re.source}, got ${JSON.stringify(raw)}`);
    return ok(lower as T);
  };

export const parseBlockchainId = parseHex<BlockchainId>(HEX32, 'BlockchainId');
export const parseGenesisHash = parseHex<GenesisHash>(HEX32, 'GenesisHash');
export const parseBlockHash = parseHex<BlockHash>(HEX32, 'BlockHash');
export const parseTransactionHash = parseHex<TransactionHash>(HEX32, 'TransactionHash');
export const parseMessageId = parseHex<MessageId>(HEX32, 'MessageId');
export const parseEvmAddress = parseHex<EvmAddress>(HEX20, 'EvmAddress');

/**
 * Non-negative integer parser shared by the numeric ids.
 * Accepts bigint or a canonical decimal string. Rejects `number` outright so a
 * value that already lost precision at the call site cannot enter the domain.
 */
const parseUint =
  <T>(label: string, max?: bigint) =>
  (raw: bigint | string): Parsed<T> => {
    let v: bigint;
    if (typeof raw === 'bigint') {
      v = raw;
    } else if (typeof raw === 'string') {
      if (!/^(0|[1-9][0-9]*)$/.test(raw))
        return err(`${label}: not a canonical decimal string: ${JSON.stringify(raw)}`);
      v = BigInt(raw);
    } else {
      return err(`${label}: expected bigint or decimal string, got ${typeof raw}`);
    }
    if (v < 0n) return err(`${label}: must be non-negative, got ${v.toString()}`);
    if (max !== undefined && v > max) return err(`${label}: exceeds maximum ${max.toString()}`);
    return ok(v as T);
  };

/** EIP-155 chain ids are bounded well below this; the cap only blocks nonsense. */
const MAX_UINT64 = (1n << 64n) - 1n;

export const parseEvmChainId = parseUint<EvmChainId>('EvmChainId', MAX_UINT64);
export const parseBlockNumber = parseUint<BlockNumber>('BlockNumber', MAX_UINT64);
export const parseLogIndex = parseUint<LogIndex>('LogIndex', MAX_UINT64);

export const parseProviderGroupId = (raw: string): Parsed<ProviderGroupId> => {
  if (typeof raw !== 'string') return err('ProviderGroupId: not a string');
  if (!PROVIDER_GROUP.test(raw)) {
    return err(`ProviderGroupId: expected ${PROVIDER_GROUP.source}, got ${JSON.stringify(raw)}`);
  }
  return ok(raw as ProviderGroupId);
};
