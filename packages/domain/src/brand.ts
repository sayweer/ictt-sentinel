/**
 * Nominal (branded) typing helper.
 *
 * Two identifiers that are both strings must not be interchangeable: an Avalanche
 * `blockchainID` and an EVM `chainId` are different fields with different values
 * (docs/PRODUCT.md, terminology lock). Branding makes that a compile-time error.
 */
declare const BRAND: unique symbol;

export type Brand<T, B extends string> = T & { readonly [BRAND]: B };

/** Result of a checked construction. Never throws; callers must handle failure. */
export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
export const err = <T = never>(error: string): Parsed<T> => ({ ok: false, error });
