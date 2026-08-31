import type { z } from 'zod';
import { canonicalDigest } from './canonical.js';
import { ConfigError, type ConfigIssue, issue } from './errors.js';
import { findInlineSecrets } from './inline-secret.js';
import { parseSafeYaml, type SafeYamlLimits } from './safe-yaml.js';
import { SUPPORTED_MANIFEST_API_VERSIONS, type Manifest, zManifest } from './schema/manifest.js';
import { SUPPORTED_POLICY_API_VERSIONS, type Policy, zPolicy } from './schema/policy.js';
import type { SecretRef } from './secret-ref.js';

/**
 * Loading pipeline, in this order on purpose:
 *
 *   1. safe YAML         - reject the language features, not just the values
 *   2. inline-secret scan - report a credential as a security error, before a
 *                           shape error can echo it back in a message
 *   3. apiVersion gate    - an unknown future version fails closed
 *   4. strict schema      - unknown properties rejected
 *   5. cross-field rules  - quorum, identity, baseline integrity
 *
 * The input is a string. `packages/config` reads neither the filesystem nor
 * `process.env`; the caller supplies both (.claude/rules/apps.md).
 */

export interface LoadedDocument<T> {
  readonly value: T;
  /** Digest of the pre-validation document: stable across key order and comments. */
  readonly digest: string;
}

const KNOWN_API_GROUP = 'sentinel.ictt/';

const checkApiVersion = (
  raw: Record<string, unknown>,
  supported: readonly string[],
  expectedKind: string,
): readonly ConfigIssue[] => {
  const apiVersion = raw['apiVersion'];
  const kind = raw['kind'];
  if (typeof apiVersion !== 'string') {
    return [issue('UNKNOWN_API_VERSION', 'apiVersion', 'is required and must be a string')];
  }
  if (typeof kind !== 'string' || kind !== expectedKind) {
    return [issue('SCHEMA', 'kind', `must be "${expectedKind}"`)];
  }
  if (supported.includes(apiVersion)) return [];
  // A version inside our own group that this build does not know is a document
  // from the future. Refusing beats guessing at semantics we were not written
  // against (docs/SUPPORT_MATRIX.md 8).
  const code = apiVersion.startsWith(KNOWN_API_GROUP)
    ? 'UNSUPPORTED_API_VERSION'
    : 'UNKNOWN_API_VERSION';
  return [
    issue(
      code,
      'apiVersion',
      `"${apiVersion}" is not understood by this build; supported: ${supported.join(', ')}`,
    ),
  ];
};

const zodIssues = (error: z.ZodError): readonly ConfigIssue[] =>
  error.issues.map((i) =>
    issue(
      'SCHEMA',
      i.path.map((p) => (typeof p === 'number' ? `[${String(p)}]` : p)).join('.'),
      i.message,
    ),
  );

/** Cross-field rules that a per-field schema cannot express. */
const checkManifestInvariants = (m: Manifest): readonly ConfigIssue[] => {
  const issues: ConfigIssue[] = [];

  const chains: { path: string; chain: Manifest['spec']['home']['chain'] }[] = [
    { path: 'spec.home.chain', chain: m.spec.home.chain },
    ...m.spec.remotes.map((r, i) => ({ path: `spec.remotes[${String(i)}].chain`, chain: r.chain })),
  ];

  for (const { path, chain } of chains) {
    // A chain has no verifiable identity without a genesis hash or an attested
    // checkpoint, and replay from an unanchored chain proves nothing.
    if (chain.genesisHash === undefined && chain.trustedCheckpoint === undefined) {
      issues.push(
        issue(
          'SCHEMA',
          path,
          'requires either genesisHash or trustedCheckpoint to anchor chain identity',
        ),
      );
    }

    const ids = new Set<string>();
    const domains = new Set<string>();
    for (const [i, ep] of chain.endpoints.entries()) {
      const epPath = `${path}.endpoints[${String(i)}]`;
      if (ids.has(ep.id)) {
        issues.push(
          issue('DUPLICATE_ENDPOINT', epPath, `endpoint id "${ep.id}" is used more than once`),
        );
      }
      ids.add(ep.id);
      domains.add(ep.trustDomain);
    }

    // Endpoints may share a trustDomain, but they then count as one witness.
    // Declaring a quorum the topology cannot supply is a fake quorum, and the
    // whole point of counting domains is that URLs are not evidence of
    // independence (docs/INVARIANTS.md 9).
    if (domains.size < chain.quorum.independentTrustDomains) {
      issues.push(
        issue(
          'FAKE_QUORUM',
          `${path}.endpoints`,
          `declares a quorum of ${String(chain.quorum.independentTrustDomains)} independent trust domains ` +
            `but only ${String(domains.size)} distinct trustDomain value(s) are configured`,
        ),
      );
    }

    // Accepted-state assurance cannot rest on an endpoint that may answer with
    // unfinalized state.
    if (
      chain.finality.mode === 'accepted-quorum' &&
      chain.finality.acceptedStateQueries !== 'accepted-only'
    ) {
      issues.push(
        issue(
          'SCHEMA',
          `${path}.finality.acceptedStateQueries`,
          'accepted-quorum finality requires endpoints that answer from accepted state only',
        ),
      );
    }

    // Reserved for ACP-194. Declared so the migration is visible, refused so it
    // cannot be silently treated as today's semantics.
    if (chain.finality.mode === 'settled-quorum') {
      issues.push(
        issue(
          'UNSUPPORTED_API_VERSION',
          `${path}.finality.mode`,
          'settled-quorum is reserved for ACP-194 and is not implemented; it must not be selected yet',
        ),
      );
    }
  }

  // The census window cannot start after the contract it is meant to enumerate.
  if (BigInt(m.spec.census.fromBlock) > BigInt(m.spec.home.tokenHome.deploymentBlock)) {
    issues.push(
      issue(
        'SCHEMA',
        'spec.census.fromBlock',
        'must not start after the TokenHome deployment block, or registrations would be missed',
      ),
    );
  }

  // An Avalanche blockchainID and an EVM chainId are different fields with
  // different values; a document that repeats one as the other is misconfigured
  // even when both parse (docs/PRODUCT.md 6).
  for (const { path, chain } of chains) {
    if (chain.blockchainId === chain.subnetId) {
      issues.push(
        issue(
          'SCHEMA',
          `${path}.subnetId`,
          'must not equal blockchainId; they identify different things',
        ),
      );
    }
  }

  const seenBlockchainIds = new Map<string, string>();
  for (const { path, chain } of chains) {
    const prior = seenBlockchainIds.get(chain.blockchainId);
    if (prior !== undefined) {
      issues.push(
        issue('SCHEMA', `${path}.blockchainId`, `duplicates the blockchainId declared at ${prior}`),
      );
    }
    seenBlockchainIds.set(chain.blockchainId, path);
  }

  return issues;
};

const loadDocument = <T>(
  source: string,
  supported: readonly string[],
  expectedKind: string,
  schema: z.ZodType<T>,
  extra: (value: T) => readonly ConfigIssue[],
  limits?: SafeYamlLimits,
): LoadedDocument<T> => {
  const raw = parseSafeYaml(source, limits) as Record<string, unknown>;

  const inline = findInlineSecrets(raw);
  if (inline.length > 0)
    throw new ConfigError(inline, 'configuration contains inline credential material');

  const version = checkApiVersion(raw, supported, expectedKind);
  if (version.length > 0) throw new ConfigError(version);

  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(zodIssues(parsed.error));

  const invariants = extra(parsed.data);
  if (invariants.length > 0) throw new ConfigError(invariants);

  return { value: parsed.data, digest: canonicalDigest(raw) };
};

export const loadManifest = (source: string, limits?: SafeYamlLimits): LoadedDocument<Manifest> =>
  loadDocument(
    source,
    SUPPORTED_MANIFEST_API_VERSIONS,
    'ICTTDeployment',
    zManifest,
    checkManifestInvariants,
    limits,
  );

export const loadPolicy = (source: string, limits?: SafeYamlLimits): LoadedDocument<Policy> =>
  loadDocument(source, SUPPORTED_POLICY_API_VERSIONS, 'SentinelPolicy', zPolicy, () => [], limits);

/** Every secret the manifest references, in document order, de-duplicated. */
export const collectSecretRefs = (m: Manifest): readonly SecretRef[] => {
  const refs: string[] = [];
  for (const ep of m.spec.home.chain.endpoints) refs.push(ep.secretRef);
  for (const r of m.spec.remotes) for (const ep of r.chain.endpoints) refs.push(ep.secretRef);
  return [...new Set(refs)] as SecretRef[];
};
