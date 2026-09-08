import { RpcIntegrityConflict } from './errors.js';

/**
 * Independent witness quorum.
 *
 * Quorum is counted over witnesses that are independent by BOTH providerGroup
 * and trustDomain, never over URLs. Two hostnames in front of one upstream are
 * one witness; two accounts controlled by one provider are also one witness.
 * Treating either relationship as independent is how a single point of failure
 * gets reported as agreement
 * (docs/INVARIANTS.md section 9).
 *
 * This is not a Byzantine or cryptographic proof and must never be described as
 * one: independent providers can share an upstream, and the product's own
 * documentation says so.
 */

export interface WitnessObservation {
  readonly endpointId: string;
  readonly trustDomain: string;
  readonly providerGroup: string;
  /** Avalanche ICM identity as reported by the endpoint. */
  readonly blockchainId?: string;
  /** Genesis or operator-attested anchor hash read at its configured height. */
  readonly genesisHash?: string;
  readonly evmChainId?: bigint;
  readonly networkId?: bigint;
  readonly headBlockNumber: bigint;
  /** Hash the endpoint reports at the height being agreed on. */
  readonly hashAtHeight?: string;
  readonly observedAtMs: number;
  readonly archiveDepth: 'full' | 'pruned' | 'unknown';
}

export interface ExpectedIdentity {
  readonly blockchainId: string;
  readonly genesisHash?: string;
  readonly evmChainId: bigint;
  readonly networkId: bigint;
}

export interface QuorumPolicy {
  readonly minIndependentTrustDomains: number;
  /** How far behind the leading witness a head may be and still count. */
  readonly maxHeadLagBlocks: bigint;
  /** How old an observation may be before it is stale. */
  readonly maxObservationAgeMs: number;
}

export const WITNESS_REJECTIONS = [
  'wrong-blockchain-id',
  'wrong-genesis-hash',
  'wrong-evm-chain-id',
  'wrong-network-id',
  'missing-identity',
  'stale-observation',
  'head-lagging',
  'head-in-future',
  'no-hash-at-height',
] as const;
export type WitnessRejection = (typeof WITNESS_REJECTIONS)[number];

export interface RejectedWitness {
  readonly endpointId: string;
  readonly trustDomain: string;
  readonly reason: WitnessRejection;
  readonly detail: string;
}

export type QuorumOutcome =
  'agreed' | 'insufficient-witnesses' | 'disagreement' | 'no-common-height';

export interface QuorumResult {
  readonly outcome: QuorumOutcome;
  /** Height every counted witness agreed on. Present only when agreed. */
  readonly height?: bigint;
  readonly blockHash?: string;
  /** Distinct trustDomains in the selected independent witness set. */
  readonly agreeingTrustDomains: readonly string[];
  /** Distinct providerGroups in the selected independent witness set. */
  readonly agreeingProviderGroups: readonly string[];
  /** Endpoints that contributed, for provenance. */
  readonly agreeingEndpointIds: readonly string[];
  readonly rejected: readonly RejectedWitness[];
  readonly reasons: readonly string[];
  /** Completeness metadata: what the caller could not establish. */
  readonly degraded: readonly string[];
}

const lower = (s: string | undefined): string | undefined => s?.toLowerCase();

/**
 * Collapse transitive shared trust domains or provider groups into one failure
 * domain. If A shares a provider with B and B shares a trust domain with C,
 * none of the three is evidence of an independent failure path. This is the
 * same conservative relation used by the CLI and offline evidence verifier.
 */
const independentWitnesses = (
  observations: readonly WitnessObservation[],
): readonly WitnessObservation[] => {
  const ordered = [...observations].sort((a, b) =>
    `${a.trustDomain}\0${a.providerGroup}\0${a.endpointId}`.localeCompare(
      `${b.trustDomain}\0${b.providerGroup}\0${b.endpointId}`,
    ),
  );
  const components: {
    domains: Set<string>;
    providers: Set<string>;
    observations: WitnessObservation[];
  }[] = [];
  for (const observation of ordered) {
    const joined = components.filter(
      (component) =>
        component.domains.has(observation.trustDomain) ||
        component.providers.has(observation.providerGroup),
    );
    const merged = {
      domains: new Set([observation.trustDomain]),
      providers: new Set([observation.providerGroup]),
      observations: [observation],
    };
    for (const component of joined) {
      for (const domain of component.domains) merged.domains.add(domain);
      for (const provider of component.providers) merged.providers.add(provider);
      merged.observations.push(...component.observations);
      components.splice(components.indexOf(component), 1);
    }
    components.push(merged);
  }
  return components
    .map(
      (component) =>
        component.observations.sort((a, b) => a.endpointId.localeCompare(b.endpointId))[0],
    )
    .filter((observation): observation is WitnessObservation => observation !== undefined)
    .sort((a, b) => a.endpointId.localeCompare(b.endpointId));
};

/**
 * Select a common observable height and check agreement on it.
 *
 * The height chosen is the lowest head among admissible witnesses, so every
 * counted witness has actually seen it. Picking the highest would mean asking a
 * lagging endpoint about a block it does not have yet and reading the resulting
 * failure as disagreement.
 */
export const evaluateQuorum = (
  observations: readonly WitnessObservation[],
  expected: ExpectedIdentity,
  policy: QuorumPolicy,
  nowMs: number,
): QuorumResult => {
  const rejected: RejectedWitness[] = [];
  const degraded: string[] = [];

  const admissible: WitnessObservation[] = [];
  for (const o of observations) {
    const reject = (reason: WitnessRejection, detail: string): void => {
      rejected.push({ endpointId: o.endpointId, trustDomain: o.trustDomain, reason, detail });
    };

    if (o.blockchainId === undefined || o.evmChainId === undefined || o.networkId === undefined) {
      reject('missing-identity', 'the endpoint did not establish a full chain identity');
      continue;
    }
    // An Avalanche blockchainID and an EVM chainId are different fields with
    // different values; both must match, and neither substitutes for the other.
    if (lower(o.blockchainId) !== lower(expected.blockchainId)) {
      reject('wrong-blockchain-id', 'the endpoint serves a different Avalanche blockchain');
      continue;
    }
    if (
      expected.genesisHash !== undefined &&
      lower(o.genesisHash) !== lower(expected.genesisHash)
    ) {
      reject('wrong-genesis-hash', 'the endpoint does not match the configured genesis anchor');
      continue;
    }
    if (o.evmChainId !== expected.evmChainId) {
      reject('wrong-evm-chain-id', 'the endpoint serves a different EVM chain id');
      continue;
    }
    if (o.networkId !== expected.networkId) {
      reject('wrong-network-id', 'the endpoint serves a different Avalanche network');
      continue;
    }
    if (nowMs - o.observedAtMs > policy.maxObservationAgeMs) {
      reject('stale-observation', 'the observation is older than the freshness policy allows');
      continue;
    }
    admissible.push(o);
  }

  if (admissible.length === 0) {
    return {
      outcome: 'insufficient-witnesses',
      agreeingTrustDomains: [],
      agreeingProviderGroups: [],
      agreeingEndpointIds: [],
      rejected,
      reasons: ['no endpoint established the expected chain identity within the freshness window'],
      degraded,
    };
  }

  const leadingHead = admissible.reduce(
    (m, o) => (o.headBlockNumber > m ? o.headBlockNumber : m),
    0n,
  );
  const notLagging: WitnessObservation[] = [];
  for (const o of admissible) {
    if (leadingHead - o.headBlockNumber > policy.maxHeadLagBlocks) {
      rejected.push({
        endpointId: o.endpointId,
        trustDomain: o.trustDomain,
        reason: 'head-lagging',
        detail: `head is ${(leadingHead - o.headBlockNumber).toString()} blocks behind the leading witness`,
      });
      degraded.push(`${o.endpointId}: head lagging`);
      continue;
    }
    notLagging.push(o);
  }

  if (notLagging.length === 0) {
    return {
      outcome: 'insufficient-witnesses',
      agreeingTrustDomains: [],
      agreeingProviderGroups: [],
      agreeingEndpointIds: [],
      rejected,
      reasons: ['every witness was outside the head-lag policy'],
      degraded,
    };
  }

  // The lowest head among admissible witnesses is the highest block all of them
  // can actually answer for. Asking about a higher one would make a lagging
  // endpoint fail and read as disagreement.
  const [firstWitness, ...restWitnesses] = notLagging;
  if (firstWitness === undefined) {
    return {
      outcome: 'insufficient-witnesses',
      agreeingTrustDomains: [],
      agreeingProviderGroups: [],
      agreeingEndpointIds: [],
      rejected,
      reasons: ['no witness remained after the head-lag filter'],
      degraded,
    };
  }
  const height = restWitnesses.reduce<bigint>(
    (m, o) => (o.headBlockNumber < m ? o.headBlockNumber : m),
    firstWitness.headBlockNumber,
  );

  const withHash: WitnessObservation[] = [];
  for (const o of notLagging) {
    if (o.hashAtHeight === undefined) {
      rejected.push({
        endpointId: o.endpointId,
        trustDomain: o.trustDomain,
        reason: 'no-hash-at-height',
        detail: 'the endpoint did not return a block hash at the common height',
      });
      degraded.push(`${o.endpointId}: no hash at the common height`);
      continue;
    }
    withHash.push(o);
  }

  const byHash = new Map<string, WitnessObservation[]>();
  for (const o of withHash) {
    const key = o.hashAtHeight?.toLowerCase() ?? '';
    byHash.set(key, [...(byHash.get(key) ?? []), o]);
  }

  if (byHash.size === 0) {
    return {
      outcome: 'no-common-height',
      agreeingTrustDomains: [],
      agreeingProviderGroups: [],
      agreeingEndpointIds: [],
      rejected,
      reasons: ['no witness supplied a hash at the common height'],
      degraded,
    };
  }

  // Same height, different hash. There is no majority rule here: choosing a
  // winner would manufacture certainty out of a contradiction.
  if (byHash.size > 1) {
    return {
      outcome: 'disagreement',
      height,
      agreeingTrustDomains: [],
      agreeingProviderGroups: [],
      agreeingEndpointIds: [],
      rejected,
      reasons: [
        `witnesses report ${String(byHash.size)} different hashes at height ${height.toString()}; ` +
          'no hash is selected, because picking one would invent agreement',
      ],
      degraded,
    };
  }

  const [hash, group] = [...byHash.entries()][0] ?? ['', []];
  const independent = independentWitnesses(group);
  const trustDomains = independent.map((o) => o.trustDomain).sort();
  const providerGroups = independent.map((o) => o.providerGroup).sort();

  if (independent.length < policy.minIndependentTrustDomains) {
    return {
      outcome: 'insufficient-witnesses',
      height,
      blockHash: hash,
      agreeingTrustDomains: trustDomains,
      agreeingProviderGroups: providerGroups,
      agreeingEndpointIds: independent.map((o) => o.endpointId),
      rejected,
      reasons: [
        `${String(group.length)} endpoint(s) agreed but only ${String(independent.length)} ` +
          `witness(es) are independent by provider group and trust domain; policy requires ${String(policy.minIndependentTrustDomains)}. ` +
          'Multiple URLs or identities behind one provider count as one witness.',
      ],
      degraded,
    };
  }

  return {
    outcome: 'agreed',
    height,
    blockHash: hash,
    agreeingTrustDomains: trustDomains,
    agreeingProviderGroups: providerGroups,
    agreeingEndpointIds: independent.map((o) => o.endpointId),
    rejected,
    reasons: [],
    degraded,
  };
};

/**
 * A height already recorded as accepted, kept so a later contradiction is
 * detectable.
 */
export interface AcceptedRecord {
  readonly blockNumber: bigint;
  readonly blockHash: string;
}

/**
 * Compare a fresh observation against what was already recorded as accepted.
 *
 * Avalanche acceptance is final. A different hash at a height already accepted
 * is therefore not a reorg, and must not be rolled back as one: the recorded
 * evidence is preserved and the evaluation stops with an integrity conflict.
 */
export const assertNoIntegrityConflict = (
  recorded: AcceptedRecord | undefined,
  observed: { blockNumber: bigint; blockHash: string; endpointId: string; trustDomain: string },
): void => {
  if (recorded === undefined) return;
  if (recorded.blockNumber !== observed.blockNumber) return;
  if (recorded.blockHash.toLowerCase() === observed.blockHash.toLowerCase()) return;
  throw new RpcIntegrityConflict({
    blockNumber: observed.blockNumber,
    recordedHash: recorded.blockHash,
    observedHash: observed.blockHash,
    endpointId: observed.endpointId,
    trustDomain: observed.trustDomain,
  });
};
