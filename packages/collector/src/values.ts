/**
 * Shape checks for values a provider returns. A provider is an untrusted input:
 * anything that does not fit is refused, never coerced.
 */

export class ProviderValueError extends Error {
  override readonly name = 'ProviderValueError';
}

export const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderValueError('Expected object.');
  return value as Record<string, unknown>;
};

export const hexQuantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]*)$/.test(value) || value.length > 66)
    throw new ProviderValueError('Invalid RPC quantity.');
  return BigInt(value);
};

export const bytes32 = (value: unknown): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value))
    throw new ProviderValueError('Invalid bytes32.');
  return value;
};
