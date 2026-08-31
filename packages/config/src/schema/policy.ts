import { z } from 'zod';

/**
 * SentinelPolicy, apiVersion `sentinel.ictt/v1alpha1`.
 *
 * Policy is the operational half of the contract: how fresh evidence must be,
 * how many independent witnesses count, and what happens when the answer cannot
 * be established. It is hashed into every evaluation alongside the manifest.
 */

export const POLICY_KIND = 'SentinelPolicy' as const;
export const SUPPORTED_POLICY_API_VERSIONS = ['sentinel.ictt/v1alpha1'] as const;

/**
 * The lattice, spelled out so a policy file cannot reorder it. Kept in the same
 * order as `@ictt-sentinel/domain` and asserted by test.
 */
export const zVerdictPrecedence = z
  .tuple([z.literal('CRITICAL'), z.literal('UNKNOWN'), z.literal('WARN'), z.literal('OK')])
  .describe('most severe first; a required UNKNOWN outranks WARN');

export const zEvidence = z.strictObject({
  /** Beyond this age evidence is stale and the verdict degrades to UNKNOWN. */
  maxAgeSeconds: z.int().positive().max(86_400),
  /** Hard expiry after which a cached evaluation may not be reported at all. */
  expiresAfterSeconds: z.int().positive().max(604_800),
  /** Reproduction promise: same pinned blocks and rule version, same digest. */
  requireReproducibleDigest: z.literal(true),
});

export const zQuorum = z.strictObject({
  /** Counted over distinct trustDomains, never over URLs. */
  minIndependentTrustDomains: z.int().min(2).max(8),
  /** Disagreement on a pinned block hash is a data fault, not a tiebreak. */
  onDisagreement: z.literal('UNKNOWN'),
  onInsufficientWitnesses: z.literal('UNKNOWN'),
});

export const zDataPath = z.strictObject({
  requestTimeoutMs: z.int().min(100).max(120_000),
  maxRetries: z.int().min(0).max(5),
  retryBackoffMs: z.int().min(10).max(60_000),
  /** Bounded log window so a provider cannot be asked for an unbounded range. */
  maxLogRangeBlocks: z.int().min(1).max(100_000),
  /**
   * Comparative reads pin an explicit block number and hash. Falling back to
   * `latest` would compare two chains at two different moments, which is the
   * error this product exists to catch (docs/adr/0002-accepted-quorum-truth.md).
   */
  allowLatestFallback: z.literal(false),
  /** A webhook is a latency hint. It never writes a canonical fact. */
  webhookMayProduceVerdict: z.literal(false),
});

/**
 * Per token mode behaviour.
 *
 * Native remotes get `sufficient | indeterminate | unknown` only. The contract's
 * reported supply is an accounting reconstruction that includes an unbacked
 * initial reserve, so exact circulating-supply equality is not claimable
 * (docs/INVARIANTS.md 7).
 */
export const zTokenModes = z.strictObject({
  canonicalErc20: z.strictObject({
    reconciliation: z.literal('deterministic'),
    onQuietSectionMismatch: z.enum(['WARN', 'CRITICAL']),
    onCausalBreach: z.literal('CRITICAL'),
  }),
  native: z.strictObject({
    claim: z.literal('reported-supply-upper-bound'),
    allowedAssessments: z.tuple([
      z.literal('sufficient'),
      z.literal('indeterminate'),
      z.literal('unknown'),
    ]),
    /** Above the bound is not proof of a shortfall; it needs reconciliation. */
    onBoundExceeded: z.literal('indeterminate'),
    allowExactSupplyClaim: z.literal(false),
  }),
  unsupported: z.strictObject({
    /** Rebase, fee-on-transfer, custom remotes, unrecognised forks. */
    behaviour: z.literal('UNKNOWN'),
    failClosed: z.literal(true),
  }),
});

export const zDriftSeverity = z.strictObject({
  LOCKED: z.literal('CRITICAL'),
  APPROVED_CHANGE: z.enum(['WARN', 'CRITICAL']),
  OBSERVE_ONLY: z.literal('WARN'),
  /** A remote discovered but never approved is candidate drift, not trusted. */
  candidateRemote: z.enum(['WARN', 'CRITICAL']),
  unknownFingerprint: z.literal('UNKNOWN'),
});

export const zPolicySpec = z.strictObject({
  verdictPrecedence: zVerdictPrecedence,
  evidence: zEvidence,
  quorum: zQuorum,
  dataPath: zDataPath,
  tokenModes: zTokenModes,
  configDrift: zDriftSeverity,
});

export const zPolicy = z.strictObject({
  apiVersion: z.enum(SUPPORTED_POLICY_API_VERSIONS),
  kind: z.literal(POLICY_KIND),
  metadata: z.strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/),
    description: z.string().min(1).max(200).optional(),
  }),
  spec: zPolicySpec,
});

export type Policy = z.infer<typeof zPolicy>;
export type PolicySpec = z.infer<typeof zPolicySpec>;
