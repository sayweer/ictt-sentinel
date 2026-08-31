import { type ScalingResult, deriveTokenMultiplierValues } from './scaling.js';

/**
 * Home and remote linkage.
 *
 * A pair only means something if both sides point at each other with the same
 * identities and the same scaling. Checking one direction is how a misconfigured
 * remote passes: it can name the right home while the home has never heard of it.
 */

export interface HomeSideLinkage {
  readonly homeBlockchainId: string;
  readonly tokenHomeAddress: string;
  readonly tokenAddress: string;
  readonly homeTokenDecimals: number;
  readonly teleporterRegistryAddress: string;
  /** Settings the home stores for this remote. Absent means never registered. */
  readonly registeredRemote?: {
    readonly remoteBlockchainId: string;
    readonly remoteTokenTransferrerAddress: string;
    readonly registered: boolean;
    readonly collateralNeeded: bigint;
    readonly tokenMultiplier: bigint;
    readonly multiplyOnRemote: boolean;
  };
}

export interface RemoteSideLinkage {
  readonly remoteBlockchainId: string;
  readonly tokenRemoteAddress: string;
  /** Home identity as the remote itself stores it. */
  readonly tokenHomeBlockchainId: string;
  readonly tokenHomeAddress: string;
  readonly remoteTokenDecimals: number;
  readonly tokenMultiplier: bigint;
  readonly multiplyOnRemote: boolean;
  readonly teleporterRegistryAddress: string;
  readonly isCollateralized: boolean;
  readonly initialReserveImbalance: bigint;
}

export const LINKAGE_FAULTS = [
  'remote-not-registered-at-home',
  'home-blockchain-id-mismatch',
  'home-address-mismatch',
  'remote-blockchain-id-mismatch',
  'remote-address-mismatch',
  'scaling-mismatch',
  'derived-scaling-mismatch',
  'teleporter-registry-mismatch',
  'collateral-outstanding',
  'reserve-imbalance-inconsistent',
  'scaling-underivable',
] as const;
export type LinkageFault = (typeof LINKAGE_FAULTS)[number];

export interface LinkageFinding {
  readonly fault: LinkageFault;
  readonly detail: string;
}

export interface LinkageResult {
  readonly linked: boolean;
  readonly findings: readonly LinkageFinding[];
}

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Verify a home and remote pair describe each other consistently.
 *
 * Every check is mutual. The scaling values are additionally re-derived from the
 * two decimal counts, so a pair that agrees with itself but disagrees with the
 * protocol's own derivation is still caught.
 */
export const checkLinkage = (home: HomeSideLinkage, remote: RemoteSideLinkage): LinkageResult => {
  const findings: LinkageFinding[] = [];
  const add = (fault: LinkageFault, detail: string): void => {
    findings.push({ fault, detail });
  };

  if (!eq(remote.tokenHomeBlockchainId, home.homeBlockchainId)) {
    add(
      'home-blockchain-id-mismatch',
      'the remote names a different home blockchain than the home itself',
    );
  }
  if (!eq(remote.tokenHomeAddress, home.tokenHomeAddress)) {
    add(
      'home-address-mismatch',
      'the remote names a different TokenHome address than the home itself',
    );
  }

  const reg = home.registeredRemote;
  if (reg === undefined || !reg.registered) {
    add(
      'remote-not-registered-at-home',
      'the home has no registration for this remote; the remote naming the home proves nothing on its own',
    );
  } else {
    if (!eq(reg.remoteBlockchainId, remote.remoteBlockchainId)) {
      add(
        'remote-blockchain-id-mismatch',
        'the home registration points at a different remote blockchain',
      );
    }
    if (!eq(reg.remoteTokenTransferrerAddress, remote.tokenRemoteAddress)) {
      add('remote-address-mismatch', 'the home registration points at a different remote address');
    }
    if (
      reg.tokenMultiplier !== remote.tokenMultiplier ||
      reg.multiplyOnRemote !== remote.multiplyOnRemote
    ) {
      add(
        'scaling-mismatch',
        'home and remote disagree on tokenMultiplier or multiplyOnRemote; every converted amount would differ',
      );
    }
    if (reg.collateralNeeded > 0n) {
      add(
        'collateral-outstanding',
        `the home still needs ${reg.collateralNeeded.toString()} base units of collateral for this remote`,
      );
    }
  }

  // Re-derive from decimals: the pair can agree with itself and still not match
  // what the protocol would have produced.
  const derived = deriveTokenMultiplierValues(
    BigInt(home.homeTokenDecimals),
    BigInt(remote.remoteTokenDecimals),
  );
  if (!derived.ok) {
    add(
      'scaling-underivable',
      `scaling cannot be derived from the declared decimals: ${derived.reason}`,
    );
  } else if (
    derived.value.tokenMultiplier !== remote.tokenMultiplier ||
    derived.value.multiplyOnRemote !== remote.multiplyOnRemote
  ) {
    add(
      'derived-scaling-mismatch',
      'the stored scaling does not match what the protocol derives from the declared decimals',
    );
  }

  if (!eq(remote.teleporterRegistryAddress, home.teleporterRegistryAddress)) {
    add(
      'teleporter-registry-mismatch',
      'home and remote use different Teleporter registries; messages would cross messaging domains',
    );
  }

  // In the pinned source an ERC20 remote is constructed with a reserve
  // imbalance of exactly zero, so `isCollateralized` is true from birth. A
  // native remote requires a non-zero imbalance. A remote reporting itself
  // collateralised while carrying an outstanding imbalance is inconsistent.
  if (
    remote.isCollateralized &&
    remote.initialReserveImbalance > 0n &&
    home.registeredRemote?.collateralNeeded !== 0n
  ) {
    add(
      'reserve-imbalance-inconsistent',
      'the remote reports itself collateralised while an initial reserve imbalance is still outstanding at home',
    );
  }

  return { linked: findings.length === 0, findings };
};

/**
 * Scale a home amount to remote units for this pair, refusing when the two
 * sides disagree. Converting through a disputed multiplier would produce a
 * number with no defensible meaning.
 */
export const scaleForPair = (
  home: HomeSideLinkage,
  remote: RemoteSideLinkage,
  homeAmount: bigint,
  apply: (m: bigint, mor: boolean, amount: bigint) => ScalingResult,
): ScalingResult | { readonly ok: false; readonly reason: 'linkage-unverified' } => {
  const linkage = checkLinkage(home, remote);
  if (!linkage.linked) return { ok: false, reason: 'linkage-unverified' };
  return apply(remote.tokenMultiplier, remote.multiplyOnRemote, homeAmount);
};
