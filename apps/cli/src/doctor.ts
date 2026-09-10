import {
  codeHash,
  EIP1967_SLOTS,
  PINNED_COMMIT_SHA,
  SOURCE_DESCRIPTORS,
} from '@ictt-sentinel/ictt-adapters';
import {
  collectSecretRefs,
  type Manifest,
  type Policy,
  type Endpoint,
} from '@ictt-sentinel/config';
import { domainSeparatedSha256, endpointPseudonym } from '@ictt-sentinel/evidence';
import {
  correlateEndpoints,
  type EndpointCorrelationInput,
  type ReadOperation,
} from '@ictt-sentinel/rpc-quorum';
import {
  bytes32,
  hexQuantity,
  object,
  independentCount,
  type Pin,
  type Runtime,
} from './runtime.js';

export const deployments = (manifest: Manifest) => [
  { chain: manifest.spec.home.chain, contract: manifest.spec.home.tokenHome },
  ...manifest.spec.remotes.map((r) => ({ chain: r.chain, contract: r.tokenRemote })),
];
export const witnessId = (deploymentId: string, endpointId: string): string =>
  endpointPseudonym(
    (s) => domainSeparatedSha256('ictt-sentinel/endpoint/v1', s),
    deploymentId,
    endpointId,
  );
const EMPTY_HOST = { addresses: [] as readonly string[], cnames: [] as readonly string[] };

/** The host an endpoint actually points at, or null when it cannot be told. */
const hostnameOf = (
  endpoint: Endpoint,
  env: Readonly<Record<string, string | undefined>>,
): string | null => {
  const raw = env[endpoint.secretRef];
  if (raw === undefined) return null;
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
};

/**
 * A conclusive correlation means one witness wearing two names, so the pair is
 * given one trust domain and the existing count collapses it. Nothing about the
 * counting rule changes; only the input is corrected.
 */
const collapseMerged = (
  endpoints: readonly Endpoint[],
  identify: (endpoint: Endpoint) => string,
  merges: readonly (readonly [string, string])[],
): readonly Pick<Endpoint, 'trustDomain' | 'providerGroup'>[] => {
  const domains = new Map(endpoints.map((e) => [identify(e), e.trustDomain]));
  for (const [left, right] of merges) {
    const a = domains.get(left);
    const b = domains.get(right);
    if (a === undefined || b === undefined) continue;
    const winner = a < b ? a : b;
    for (const [id, domain] of domains) if (domain === a || domain === b) domains.set(id, winner);
  }
  return endpoints.map((e) => ({
    trustDomain: domains.get(identify(e)) ?? e.trustDomain,
    providerGroup: e.providerGroup,
  }));
};

/**
 * Independent witness count, corrected by what the endpoints actually point at.
 *
 * `declared` is every endpoint the manifest lists for the chain, because a
 * misconfiguration is worth reporting even when that endpoint failed its probe.
 * `counted` is the subset that may back a quorum, and is the only list the
 * returned count is computed over.
 */
export const correlatedIndependence = async (
  deploymentId: string,
  declared: readonly Endpoint[],
  counted: readonly Endpoint[],
  env: Readonly<Record<string, string | undefined>>,
  runtime: Runtime,
  signal: AbortSignal,
) => {
  const identify = (endpoint: Endpoint) => witnessId(deploymentId, endpoint.id);
  const resolutions = new Map<string, typeof EMPTY_HOST>();
  const inputs: EndpointCorrelationInput[] = [];
  for (const endpoint of declared) {
    signal.throwIfAborted();
    const hostname = hostnameOf(endpoint, env);
    if (hostname !== null && !resolutions.has(hostname))
      resolutions.set(hostname, (await runtime.resolveHost?.(hostname, signal)) ?? EMPTY_HOST);
    const resolved = hostname === null ? EMPTY_HOST : (resolutions.get(hostname) ?? EMPTY_HOST);
    inputs.push({
      endpointId: identify(endpoint),
      trustDomain: endpoint.trustDomain,
      secretRef: endpoint.secretRef,
      hostname,
      addresses: resolved.addresses,
      cnames: resolved.cnames,
    });
  }
  const { findings, merges } = correlateEndpoints(inputs, (input) =>
    domainSeparatedSha256('ictt-sentinel/correlation/v1', input),
  );
  return {
    findings,
    // Whether DNS answered at all, so an empty finding list is not read as
    // "checked and clean" when nothing could be resolved.
    resolved: inputs.some((i) => i.addresses.length > 0 || i.cnames.length > 0),
    collapsed: merges.length > 0,
    independent: independentCount(collapseMerged(counted, identify, merges)),
  };
};

const slotAddress = (value: unknown): string | null => {
  const word = bytes32(value);
  if (!/^0x0{24}/.test(word)) throw new Error('Non-address slot.');
  return /^0x0{64}$/.test(word) ? null : `0x${word.slice(-40)}`;
};

export const probeDeployment = async (
  deployment: ReturnType<typeof deployments>[number],
  endpoint: Endpoint,
  pin: Pin,
  runtime: Runtime,
  signal: AbortSignal,
) => {
  const { chain, contract } = deployment;
  const read = (op: ReadOperation) => runtime.read(endpoint, op, signal);
  const at = { kind: 'number' as const, number: BigInt(pin.blockNumber) };
  const block = async (number: bigint) =>
    object(
      await read({ op: 'block-by-ref', ref: { kind: 'number', number }, fullTransactions: false }),
    );
  const initial = await block(at.number);
  const pinned =
    bytes32(initial['hash']) === pin.blockHash && hexQuantity(initial['number']) === at.number;
  const evm = hexQuantity(await read({ op: 'evm-chain-id' }));
  const network = await read({ op: 'network-version' });
  const warp = bytes32(await read({ op: 'warp-blockchain-id', at }));
  const anchorNumber =
    chain.genesisHash === undefined ? BigInt(chain.trustedCheckpoint?.blockNumber ?? '0') : 0n;
  const anchorHash = chain.genesisHash ?? chain.trustedCheckpoint?.blockHash;
  const anchor = await block(anchorNumber);
  const identity =
    pinned &&
    evm === BigInt(chain.evmChainId) &&
    network === String(chain.networkId) &&
    warp === chain.blockchainId &&
    bytes32(anchor['hash']) === anchorHash &&
    hexQuantity(anchor['number']) === anchorNumber;
  let finality = false;
  try {
    const finalized = object(
      await read({
        op: 'block-by-ref',
        ref: { kind: 'tag', tag: 'finalized' },
        fullTransactions: false,
      }),
    );
    const number = hexQuantity(finalized['number']);
    const exact = await block(number);
    const age = Math.floor(runtime.now() / 1000) - Number(hexQuantity(finalized['timestamp']));
    finality =
      number >= at.number &&
      bytes32(finalized['hash']) === bytes32(exact['hash']) &&
      age >= 0 &&
      age <= chain.finality.maxLagSeconds &&
      chain.finality.acceptedStateQueries === 'accepted-only';
  } catch {
    signal.throwIfAborted();
  }
  const runtimeCode = await read({ op: 'code', address: contract.address, at });
  const runtimeHash =
    typeof runtimeCode === 'string' && runtimeCode !== '0x' ? codeHash(runtimeCode) : null;
  const slots = await Promise.all(
    ['implementation', 'admin', 'beacon'].map(async (name) =>
      slotAddress(
        await read({
          op: 'storage-slot',
          address: contract.address,
          slot: EIP1967_SLOTS[name as keyof typeof EIP1967_SLOTS],
          at,
        }),
      ),
    ),
  );
  let [implementation, admin, beacon] = slots;
  implementation ??= null;
  admin ??= null;
  beacon ??= null;
  if (beacon !== null) {
    implementation = slotAddress(await read({ op: 'call', to: beacon, data: '0x5c60da1b', at }));
  }
  let implementationHash: string | null = null;
  if (implementation !== null) {
    const code = await read({ op: 'code', address: implementation, at });
    if (typeof code === 'string' && code !== '0x') implementationHash = codeHash(code);
  }
  const source = contract.fingerprint.sourceRef;
  const descriptor = SOURCE_DESCRIPTORS.find((d) => d.sourcePath === source?.path);
  const proxyMatches =
    contract.proxy.kind === 'none'
      ? implementation === null && admin === null && beacon === null
      : implementation !== null &&
        contract.proxy.implementation === implementation &&
        (contract.proxy.kind === 'beacon' ? beacon !== null : beacon === null) &&
        (contract.proxy.admin ?? null) === admin;
  const fingerprint =
    source?.commitSha === PINNED_COMMIT_SHA &&
    descriptor?.role === contract.role &&
    descriptor.support === 'supported' &&
    runtimeHash === contract.fingerprint.runtimeCodeHash &&
    proxyMatches &&
    (implementation === null ||
      (implementationHash !== null &&
        contract.fingerprint.allowedImplementationHashes.includes(implementationHash)));
  let archive = false;
  try {
    const from = BigInt(contract.deploymentBlock);
    const historical = await block(from);
    const code = await read({
      op: 'code',
      address: contract.address,
      at: { kind: 'number', number: from },
    });
    const logs = await read({
      op: 'logs',
      fromBlock: from,
      toBlock: from,
      address: contract.address,
    });
    const after = await block(from);
    archive =
      endpoint.archiveDepth === 'full' &&
      hexQuantity(historical['number']) === from &&
      bytes32(historical['hash']) === bytes32(after['hash']) &&
      typeof code === 'string' &&
      /^0x[0-9a-f]+$/.test(code) &&
      Array.isArray(logs);
  } catch {
    signal.throwIfAborted();
  }
  const after = await block(at.number);
  const stable =
    bytes32(after['hash']) === pin.blockHash && hexQuantity(after['number']) === at.number;
  return {
    identity: identity && stable,
    finality: finality && stable,
    archive: archive && stable,
    fingerprint: fingerprint && stable,
    blockHash: bytes32(after['hash']),
    observedFingerprint: { runtimeHash, implementation, implementationHash, admin, beacon },
    acceptanceEvidence: finality
      ? 'finalized-tag-probe; explicit-number-hash-recheck; operator-accepted-only-attestation'
      : 'unproven',
  };
};

export const doctorConfigured = async (
  manifest: Manifest,
  policy: Policy,
  pins: readonly Pin[],
  env: Readonly<Record<string, string | undefined>>,
  runtime: Runtime,
  signal: AbortSignal,
) => {
  const presence = [...collectSecretRefs(manifest), 'DATABASE_URL'].map((name) => ({
    name,
    present: Boolean(env[name]),
  }));
  const chains = [];
  for (const deployment of deployments(manifest)) {
    const pin = pins.find((p) => p.blockchainId === deployment.chain.blockchainId);
    if (!pin) throw new Error('Missing pin.');
    const witnesses = [];
    for (const endpoint of deployment.chain.endpoints) {
      signal.throwIfAborted();
      let probe: Awaited<ReturnType<typeof probeDeployment>> | null = null;
      try {
        probe = await probeDeployment(deployment, endpoint, pin, runtime, signal);
      } catch {
        signal.throwIfAborted();
      }
      witnesses.push({
        endpointId: witnessId(manifest.metadata.name, endpoint.id),
        probe,
        endpoint,
      });
    }
    const required = Math.max(
      policy.spec.quorum.minIndependentTrustDomains,
      deployment.chain.quorum.independentTrustDomains,
    );
    const successful = witnesses.filter(
      (w) => w.probe?.identity && w.probe.finality && w.probe.fingerprint,
    );
    const correlation = await correlatedIndependence(
      manifest.metadata.name,
      deployment.chain.endpoints,
      successful.map((w) => w.endpoint),
      env,
      runtime,
      signal,
    );
    const independent = correlation.independent;
    const divergence = witnesses.some(
      (w) => w.probe !== null && w.probe.blockHash !== pin.blockHash,
    );
    const archive = witnesses.some((w) => w.probe?.archive && w.probe.identity);
    chains.push({
      blockchainId: pin.blockchainId,
      pin,
      required,
      independent,
      divergence,
      archive,
      correlation: { resolved: correlation.resolved, findings: correlation.findings },
      ready: independent >= required && !divergence && archive,
      witnesses: witnesses.map(({ endpointId, probe }) => ({ endpointId, probe })),
    });
  }
  const database = await runtime.database(signal);
  return {
    presence,
    chains,
    database,
    telemetry: false,
    ready: presence.every((p) => p.present) && chains.every((c) => c.ready) && database,
    trustBoundary:
      'Provider identity, independence and accepted-only settings include operator attestations; successful probes do not prove provider honesty. Archive probe tests the deployment block, not continuous history. Endpoint correlation is a misconfiguration check, not a proof of independence: a shared address or CNAME is a heuristic hint, and an empty finding list proves nothing.',
  };
};
