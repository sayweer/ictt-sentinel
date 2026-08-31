/**
 * Exact port of `TokenScalingUtils` from the pinned source.
 *
 *   icm-contracts/avalanche/utilities/TokenScalingUtils.sol
 *   @ 8fef6ef73767f4497a72d8348a0774a262e0c535
 *
 * Ported line for line rather than reimplemented, because a rounding difference
 * here is a silent accounting error: a truncated division on the way home turns
 * into an apparent shortfall that nobody can reproduce.
 *
 * Solidity 0.8.x semantics that must be preserved:
 *   - `*` reverts on overflow past uint256
 *   - `/` truncates toward zero
 *   - `/` by zero reverts
 *   - `%` by zero reverts
 */

/** `uint256 public constant MAX_TOKEN_DECIMALS = 18;` */
export const MAX_TOKEN_DECIMALS = 18n;

/** Largest value a uint256 can hold. Multiplication past this reverts on chain. */
export const MAX_UINT256 = (1n << 256n) - 1n;

export type ScalingFailure =
  | 'overflow'
  | 'division-by-zero'
  | 'negative'
  | 'decimals-out-of-range'
  | 'decimals-exceed-maximum';

export type ScalingResult =
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly reason: ScalingFailure };

/** The failure arm is shared, so it is assignable to every result union here. */
type ScalingError = { readonly ok: false; readonly reason: ScalingFailure };

const ok = (value: bigint): ScalingResult => ({ ok: true, value });
const fail = (reason: ScalingFailure): ScalingError => ({ ok: false, reason });

/**
 * `_scaleTokens` from the source:
 *
 *   if (multiplyOnRemote == isSendToRemote) return amount * tokenMultiplier;
 *   return amount / tokenMultiplier;
 *
 * A revert on chain is a failure here, never a clamped or wrapped number.
 */
const scaleTokens = (
  tokenMultiplier: bigint,
  multiplyOnRemote: boolean,
  amount: bigint,
  isSendToRemote: boolean,
): ScalingResult => {
  if (amount < 0n || tokenMultiplier < 0n) return fail('negative');
  if (multiplyOnRemote === isSendToRemote) {
    const product = amount * tokenMultiplier;
    if (product > MAX_UINT256) return fail('overflow');
    return ok(product);
  }
  if (tokenMultiplier === 0n) return fail('division-by-zero');
  return ok(amount / tokenMultiplier);
};

/** Home units to remote units. `isSendToRemote = true`. */
export const applyTokenScale = (
  tokenMultiplier: bigint,
  multiplyOnRemote: boolean,
  homeTokenAmount: bigint,
): ScalingResult => scaleTokens(tokenMultiplier, multiplyOnRemote, homeTokenAmount, true);

/** Remote units back to home units. `isSendToRemote = false`. */
export const removeTokenScale = (
  tokenMultiplier: bigint,
  multiplyOnRemote: boolean,
  remoteTokenAmount: bigint,
): ScalingResult => scaleTokens(tokenMultiplier, multiplyOnRemote, remoteTokenAmount, false);

export interface TokenMultiplierValues {
  readonly tokenMultiplier: bigint;
  readonly multiplyOnRemote: boolean;
}

export type DeriveResult =
  | { readonly ok: true; readonly value: TokenMultiplierValues }
  | { readonly ok: false; readonly reason: ScalingFailure };

/**
 * `deriveTokenMultiplierValues`:
 *
 *   multiplyOnRemote = remoteTokenDecimals > homeTokenDecimals
 *   tokenMultiplier  = 10 ** |remoteTokenDecimals - homeTokenDecimals|
 *
 * Both arguments are `uint8` on chain. `TokenHome._registerRemote` additionally
 * requires `remoteTokenDecimals <= MAX_TOKEN_DECIMALS`, which is enforced here
 * so a caller cannot derive a multiplier the contract would have rejected.
 */
export const deriveTokenMultiplierValues = (
  homeTokenDecimals: bigint,
  remoteTokenDecimals: bigint,
): DeriveResult => {
  if (homeTokenDecimals < 0n || homeTokenDecimals > 255n) return fail('decimals-out-of-range');
  if (remoteTokenDecimals < 0n || remoteTokenDecimals > 255n) return fail('decimals-out-of-range');
  if (remoteTokenDecimals > MAX_TOKEN_DECIMALS) return fail('decimals-exceed-maximum');

  const multiplyOnRemote = remoteTokenDecimals > homeTokenDecimals;
  const exponent = multiplyOnRemote
    ? remoteTokenDecimals - homeTokenDecimals
    : homeTokenDecimals - remoteTokenDecimals;
  return { ok: true, value: { tokenMultiplier: 10n ** exponent, multiplyOnRemote } };
};

/**
 * `TokenHome._registerRemote` collateral derivation:
 *
 *   collateralNeeded = removeTokenScale(m, multiplyOnRemote, initialReserveImbalance)
 *   if (multiplyOnRemote && initialReserveImbalance % m != 0) collateralNeeded += 1
 *
 * The `+1` is a deliberate round-up: `removeTokenScale` divides in this
 * direction and would otherwise leave the remainder uncollateralised. Off by one
 * here is exactly the kind of quiet shortfall this product exists to catch.
 */
export const deriveCollateralNeeded = (
  tokenMultiplier: bigint,
  multiplyOnRemote: boolean,
  initialReserveImbalance: bigint,
): ScalingResult => {
  const scaled = removeTokenScale(tokenMultiplier, multiplyOnRemote, initialReserveImbalance);
  if (!scaled.ok) return scaled;
  if (multiplyOnRemote) {
    if (tokenMultiplier === 0n) return fail('division-by-zero');
    if (initialReserveImbalance % tokenMultiplier !== 0n) {
      const rounded = scaled.value + 1n;
      if (rounded > MAX_UINT256) return fail('overflow');
      return ok(rounded);
    }
  }
  return scaled;
};
