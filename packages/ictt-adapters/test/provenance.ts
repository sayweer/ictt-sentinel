/**
 * Fixture provenance.
 *
 * Every fixture records where its facts came from, so a future reader can check
 * them against the upstream repository instead of trusting this file. No test in
 * this package touches the network: the values below were read once, at the
 * pinned commit, and are asserted against the checked-in descriptor table.
 */

export const PROVENANCE = {
  repository: 'https://github.com/ava-labs/icm-services',
  commitSha: '8fef6ef73767f4497a72d8348a0774a262e0c535',
  commitDate: '2026-08-28T19:38:58Z',
  readAt: '2026-08-31',
  /** SPDX identifier declared at the top of every pinned Solidity file. */
  sourceLicense: 'LicenseRef-Ecosystem',
  licenseNote:
    'Upstream contracts are published under LicenseRef-Ecosystem; this repository stores hashes and semantics, not copies of the source.',
} as const;

/**
 * Audit index as published upstream, with the short commits resolved to full
 * ones. Every audited commit lives in the archived `icm-contracts` repository
 * and none of them is the commit this build pins.
 */
export const UPSTREAM_AUDITS = [
  {
    auditor: 'OpenZeppelin',
    published: '2023-11-16',
    shortSha: '6ba46565',
    fullSha: '6ba46565a72a7dabb159d74963d7abc525fb6486',
    repository: 'https://github.com/ava-labs/icm-contracts',
    commitDate: '2024-03-05',
  },
  {
    auditor: 'Louis',
    published: '2024-01-10',
    shortSha: '9fcdf42d',
    fullSha: '9fcdf42da263f3e3d3a60ccf1272d9394eac06d4',
    repository: 'https://github.com/ava-labs/icm-contracts',
    commitDate: '2024-01-09',
  },
  {
    auditor: 'OpenZeppelin',
    published: '2024-06-26',
    shortSha: '9e03a1e5',
    fullSha: '9e03a1e5177e4ad8d1edcedf529e71bb2f4a8d99',
    repository: 'https://github.com/ava-labs/icm-contracts',
    commitDate: '2024-07-05',
  },
] as const;

/**
 * Facts read directly from the pinned Solidity, quoted so a reviewer can check
 * the claim without re-reading the contract.
 */
export const SOURCE_FACTS = {
  /**
   * `ERC20TokenRemoteUpgradeable.__ERC20TokenRemote_init` calls
   * `__TokenRemote_init(settings, 0, tokenDecimals)`. The reserve imbalance is
   * a hard-coded zero, and `initialReserveImbalance` appears nowhere else in
   * that file.
   */
  erc20RemoteInitialReserveImbalance: 0n,

  /**
   * `NativeTokenRemoteUpgradeable.__NativeTokenRemote_init` begins with
   * `require(initialReserveImbalance != 0, ...)` and passes decimals of 18.
   */
  nativeRemoteRequiresNonZeroReserve: true,
  nativeRemoteDecimals: 18,

  /** `TokenRemote.__TokenRemote_init_unchained`: `_isCollateralized = imbalance == 0`. */
  isCollateralizedIsImbalanceZero: true,

  /** `TokenScalingUtils.MAX_TOKEN_DECIMALS`. */
  maxTokenDecimals: 18n,

  /**
   * `TokenHome._addCollateral` writes only `collateralNeeded`. It contains zero
   * references to `_transferredBalances`.
   */
  addCollateralTouchesTransferredBalance: false,

  /** Burn addresses summed by `totalNativeAssetSupply`. */
  burnedTxFeesAddress: '0x0100000000000000000000000000000000000000',
  burnedForTransferAddress: '0x0100000000000000000000000000000000010203',
} as const;
