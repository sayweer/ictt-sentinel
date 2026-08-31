import { z } from 'zod';
import { validateSecretRefName } from '../secret-ref.js';

/**
 * Shared field shapes.
 *
 * Every object here is built with `z.strictObject`, so an unknown property is a
 * validation error rather than something silently ignored. A typo in a
 * security-relevant field must never degrade into a default.
 */

/** Avalanche ICM chain identity: a 32-byte value. Never an EVM chainId. */
export const zBlockchainId = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex value (Avalanche blockchainID)')
  .transform((s) => s.toLowerCase());

export const zBytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex value')
  .transform((s) => s.toLowerCase());

export const zEvmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex EVM address')
  .transform((s) => s.toLowerCase());

/**
 * EVM chainId. Bounded well below 2^53 so it stays exact as a JSON number;
 * anything larger is nonsense rather than a precision question.
 */
export const zEvmChainId = z.int().positive().max(4_294_967_295);

/** Avalanche network id (1 = mainnet, 5 = fuji, local networks vary). */
export const zNetworkId = z.int().positive().max(4_294_967_295);

/**
 * Block heights are read as decimal strings, not numbers: a chain can outlive
 * 2^53 and a config file is the wrong place to lose a digit.
 */
export const zBlockNumber = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'must be a canonical decimal block number written as a string');

export const zSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/, 'must be a lowercase slug');

export const zIsoTimestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    'must be an ISO-8601 UTC timestamp',
  );

/**
 * A reference to an environment variable. Validated against the allowlist so a
 * manifest cannot point the resolver at an arbitrary process variable.
 * zod fills in the document path; the message carries the reason.
 */
export const zSecretRef = z.string().superRefine((value, ctx) => {
  for (const problem of validateSecretRefName(value, '')) {
    ctx.addIssue({ code: 'custom', message: problem.message });
  }
});

export const zDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be a sha256:<hex> digest');

/** Human-facing free text. Bounded so a document cannot smuggle a payload. */
export const zLabel = z.string().min(1).max(200);
