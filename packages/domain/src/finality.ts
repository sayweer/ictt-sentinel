/**
 * Where accepted state stopped meaning executed state.
 *
 * ACP-194 (C-Chain Async Execution) separates acceptance from execution: an
 * accepted block is queued for execution, `latest` names the last EXECUTED
 * block, `safe`/`finalized` name the last SETTLED one, and a header's state root
 * belongs to an earlier settled block. The accepted-quorum truth anchor
 * (docs/adr/0002-accepted-quorum-truth.md) is therefore not valid on these
 * chains from activation onwards, and until settled-quorum is implemented the
 * honest answer there is UNKNOWN (docs/adr/0011-acp-194-accepted-state-superseded.md).
 *
 * Activation is by block timestamp, exactly as AvalancheGo gates upgrades, so a
 * pin taken before the upgrade keeps the semantics it was taken under.
 *
 * Sources, read 2026-10-09: avalanchego master `upgrade/upgrade.go` (HeliconTime)
 * and release v1.15.0 "Helicon", whose activation list includes ACP-194. The
 * identities were confirmed against the public endpoints with `eth_chainId` and
 * the Warp precompile's `getBlockchainID()`.
 */

export interface AcceptedStateSupersession {
  readonly network: 'mainnet' | 'fuji';
  readonly evmChainId: bigint;
  /** 32-byte hex, lowercase. */
  readonly blockchainId: string;
  /** Upgrade that activated ACP-194. */
  readonly upgrade: 'helicon';
  /** Unix seconds; a block at or after this timestamp runs under ACP-194. */
  readonly activatesAt: bigint;
}

export const ACCEPTED_STATE_SUPERSESSIONS: readonly AcceptedStateSupersession[] = [
  {
    network: 'mainnet',
    evmChainId: 43114n,
    blockchainId: '0x0427d4b22a2a78bcddd456742caf91b56badbff985ee19aef14573e7343fd652',
    upgrade: 'helicon',
    // 2026-09-22T15:00:00Z
    activatesAt: 1_790_089_200n,
  },
  {
    network: 'fuji',
    evmChainId: 43113n,
    blockchainId: '0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5',
    upgrade: 'helicon',
    // 2026-07-28T15:00:00Z
    activatesAt: 1_785_250_800n,
  },
];

export interface ChainIdentityRef {
  readonly evmChainId: bigint;
  readonly blockchainId: string;
}

/**
 * Whether an accepted-state reading at this block is no longer evidence of
 * executed state.
 *
 * Either identifier is enough to match. A chain that claims one C-Chain id and
 * not the other is a misconfiguration, and the answer that costs nothing when
 * wrong is to treat it as affected.
 */
export const acceptedStateSuperseded = (
  chain: ChainIdentityRef,
  blockTimestamp: bigint,
): boolean => {
  const blockchainId = chain.blockchainId.toLowerCase();
  return ACCEPTED_STATE_SUPERSESSIONS.some(
    (s) =>
      (s.evmChainId === chain.evmChainId || s.blockchainId === blockchainId) &&
      blockTimestamp >= s.activatesAt,
  );
};
