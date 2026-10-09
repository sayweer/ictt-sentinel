import { deployments, probeDeployment, witnessId } from '@ictt-sentinel/collector';
import {
  collectSecretRefs,
  type Manifest,
  type Policy,
  type Endpoint,
} from '@ictt-sentinel/config';
import { domainSeparatedSha256 } from '@ictt-sentinel/evidence';
import {
  collapsedIndependenceGroups,
  correlateEndpoints,
  type EndpointCorrelationInput,
} from '@ictt-sentinel/rpc-quorum';
import type { Pin, Runtime } from './runtime.js';

// Probing moved to @ictt-sentinel/collector so the agent can use it too; the
// CLI keeps its names.
export { deployments, probeDeployment, witnessId };

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
    independent: collapsedIndependenceGroups(counted, identify, merges).length,
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
