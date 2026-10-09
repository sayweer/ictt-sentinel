import type { Endpoint, LoadedDocument, Manifest, Policy } from '@ictt-sentinel/config';
import {
  buildBundle,
  domainSeparatedSha256,
  encodeProofInput,
  factDigest,
  replayProof,
  stateCallDigest,
  verifyBundle,
  type BundleDraft,
  type ContractFingerprint,
  type EvidenceBundle,
  type MessageRecord,
  type StateCallRecord,
  type WitnessVote,
} from '@ictt-sentinel/evidence';
import {
  AbiDecodeError,
  CALLS,
  EVENT_TOPICS,
  PINNED_COMMIT_SHA,
  SOURCE_DESCRIPTORS,
  decodeAddressResult,
  decodeBytes32Result,
  decodeCollateralAdded,
  decodeMessageExecuted,
  decodeMessageExecutionFailed,
  decodeReceiveCrossChainMessage,
  decodeRemoteRegistered,
  decodeRemoteSettingsResult,
  decodeTokensAndCall,
  decodeTokensRouted,
  decodeTokensSent,
  decodeTransferrerMessage,
  decodeUintResult,
  deriveTokenMultiplierValues,
  type EventLog,
  type TokensRoutedEvent,
} from '@ictt-sentinel/ictt-adapters';
import {
  SUPPORTED_FAMILY,
  type PinnedBlock,
  type ProofInput,
  type RemoteObservation,
} from '@ictt-sentinel/invariant-core';
import { collapsedIndependenceGroups, correlateEndpoints } from '@ictt-sentinel/rpc-quorum';
import { deployments, probeDeployment, witnessId } from '../doctor.js';
import { buildIdentity, sourceLockHash } from '../identity.js';
import { bytes32, hexQuantity, object, type Pin, type Runtime } from '../runtime.js';
import {
  assessRoute,
  type Delivery,
  type Fact,
  type MessageTrace,
  type RouteAssessment,
  type SideFacts,
} from './model.js';
import {
  agreeOnReadings,
  readChain,
  type CallQuery,
  type ChainReading,
  type LogQuery,
  type RawLog,
} from './read.js';

/**
 * Live economic collection for a canonical ERC20 deployment.
 *
 * Reads every approved chain at a pin through independent witnesses, requires
 * their complete readings to be byte-identical, decodes the agreed facts under
 * the pinned ABI, and hands the canonical ERC20 engine an input in which every
 * value is an observation. The result is an evidence bundle that the offline
 * verifier must accept before it is written; anything that cannot be
 * established is UNKNOWN with the reason named, never a default.
 */

/** Liveness threshold for a transfer in flight. A WARN signal only, never economic. */
export const PENDING_AGE_LIMIT_SECONDS = 900;
export const RULE_VERSION = 'acc-erc20-canonical@1';

export type CollectResult =
  | {
      readonly status: 'evidence';
      readonly bundle: EvidenceBundle;
    }
  | { readonly status: 'unknown'; readonly reasons: readonly string[] };

type Deployment = ReturnType<typeof deployments>[number];

interface Side {
  readonly label: string;
  readonly deployment: Deployment;
  readonly chain: Deployment['chain'];
  readonly contract: Deployment['contract'];
  readonly teleporter: Manifest['spec']['home']['teleporter'];
}

interface AgreedSide {
  readonly side: Side;
  readonly reading: ChainReading;
  readonly witnesses: readonly Endpoint[];
  readonly probe: NonNullable<Awaited<ReturnType<typeof probeDeployment>>>;
}

const lower = (s: string): string => s.toLowerCase();
const dec = (v: bigint): string => v.toString(10);

const hostnameOf =
  (env: Readonly<Record<string, string | undefined>>) =>
  (endpoint: Endpoint): string | null => {
    const raw = env[endpoint.secretRef];
    if (raw === undefined) return null;
    try {
      return new URL(raw).hostname;
    } catch {
      return null;
    }
  };

/** The pin a chain is read at: its settled block, or its accepted head. */
const choosePin = async (
  side: Side,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<Pin | null> => {
  const heights: bigint[] = [];
  for (const endpoint of side.chain.endpoints) {
    try {
      if (side.chain.finality.mode === 'settled-quorum') {
        const b = object(
          await runtime.read(
            endpoint,
            { op: 'block-by-ref', ref: { kind: 'tag', tag: 'finalized' }, fullTransactions: false },
            signal,
          ),
        );
        heights.push(hexQuantity(b['number']));
      } else {
        heights.push(
          hexQuantity(await runtime.read(endpoint, { op: 'head-block-number' }, signal)),
        );
      }
    } catch {
      signal.throwIfAborted();
    }
  }
  if (heights.length === 0) return null;
  // The lowest height every answering witness has reached.
  const number = heights.reduce((a, b) => (b < a ? b : a));
  for (const endpoint of side.chain.endpoints) {
    try {
      const b = object(
        await runtime.read(
          endpoint,
          { op: 'block-by-ref', ref: { kind: 'number', number }, fullTransactions: false },
          signal,
        ),
      );
      return {
        blockchainId: side.chain.blockchainId,
        blockNumber: number.toString(),
        blockHash: bytes32(b['hash']),
      };
    } catch {
      signal.throwIfAborted();
    }
  }
  return null;
};

const topicOf = (id: string): string => lower(id);

const homeQueries = (m: Manifest, side: Side): { logs: LogQuery[]; calls: CallQuery[] } => {
  const home = lower(m.spec.home.tokenHome.address);
  const from = BigInt(m.spec.home.tokenHome.deploymentBlock);
  const messenger = lower(side.teleporter.messengerAddress);
  const own = (name: keyof typeof EVENT_TOPICS): LogQuery => ({
    name: `home.${name}`,
    address: home,
    topics: [EVENT_TOPICS[name]],
    fromBlock: from,
  });
  const logs: LogQuery[] = [
    own('tokensSent'),
    own('tokensAndCallSent'),
    own('tokensRouted'),
    own('tokensAndCallRouted'),
    own('remoteRegistered'),
    own('collateralAdded'),
  ];
  const calls: CallQuery[] = [
    { name: 'homeEscrow.tokenAddress', to: home, data: CALLS.getTokenAddress() },
    {
      name: 'homeEscrow.escrowBalance',
      to: lower(m.spec.home.tokenHome.tokenAddress),
      data: CALLS.balanceOf(home),
    },
    {
      name: 'home.registryVersion',
      to: lower(side.teleporter.registryAddress),
      data: CALLS.getVersionFromAddress(messenger),
    },
  ];
  m.spec.remotes.forEach((r, i) => {
    const source = topicOf(r.chain.blockchainId);
    for (const name of [
      'receiveCrossChainMessage',
      'messageExecuted',
      'messageExecutionFailed',
    ] as const)
      logs.push({
        name: `home.${name}.${String(i)}`,
        address: messenger,
        topics: [EVENT_TOPICS[name], null, source],
        fromBlock: from,
      });
    calls.push(
      {
        name: `remotes.${String(i)}.transferredBalance`,
        to: home,
        data: CALLS.getTransferredBalance(
          lower(r.chain.blockchainId),
          lower(r.tokenRemote.address),
        ),
      },
      {
        name: `remotes.${String(i)}.settings`,
        to: home,
        data: CALLS.getRemoteTokenTransferrerSettings(
          lower(r.chain.blockchainId),
          lower(r.tokenRemote.address),
        ),
      },
    );
  });
  return { logs, calls };
};

const remoteQueries = (m: Manifest, i: number): { logs: LogQuery[]; calls: CallQuery[] } => {
  const r = m.spec.remotes[i];
  if (r === undefined) throw new RangeError('no such remote');
  const remote = lower(r.tokenRemote.address);
  const from = BigInt(r.tokenRemote.deploymentBlock);
  const messenger = lower(r.teleporter.messengerAddress);
  const home = topicOf(m.spec.home.chain.blockchainId);
  return {
    logs: [
      {
        name: 'remote.tokensSent',
        address: remote,
        topics: [EVENT_TOPICS.tokensSent],
        fromBlock: from,
      },
      {
        name: 'remote.tokensAndCallSent',
        address: remote,
        topics: [EVENT_TOPICS.tokensAndCallSent],
        fromBlock: from,
      },
      ...(['receiveCrossChainMessage', 'messageExecuted', 'messageExecutionFailed'] as const).map(
        (name) => ({
          name: `remote.${name}`,
          address: messenger,
          topics: [EVENT_TOPICS[name], null, home],
          fromBlock: from,
        }),
      ),
    ],
    calls: [
      { name: 'remote.totalSupply', to: remote, data: CALLS.totalSupply() },
      {
        name: 'remote.initialReserveImbalance',
        to: remote,
        data: CALLS.getInitialReserveImbalance(),
      },
      { name: 'remote.tokenHomeBlockchainID', to: remote, data: CALLS.getTokenHomeBlockchainID() },
      { name: 'remote.tokenHomeAddress', to: remote, data: CALLS.getTokenHomeAddress() },
      {
        name: 'remote.registryVersion',
        to: lower(r.teleporter.registryAddress),
        data: CALLS.getVersionFromAddress(messenger),
      },
    ],
  };
};

/** Read one chain through every independent witness and require agreement. */
const collectSide = async (args: {
  readonly m: Manifest;
  readonly side: Side;
  readonly pin: Pin;
  readonly queries: { logs: LogQuery[]; calls: CallQuery[] };
  readonly required: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runtime: Runtime;
  readonly policy: Policy;
  readonly maxLogs: number;
  readonly signal: AbortSignal;
}): Promise<AgreedSide | string> => {
  const { side, pin, runtime, signal } = args;
  const { deployment } = side;
  const eligible: { endpoint: Endpoint; probe: NonNullable<AgreedSide['probe']> }[] = [];
  for (const endpoint of side.chain.endpoints) {
    try {
      const probe = await probeDeployment(deployment, endpoint, pin, runtime, signal);
      if (probe.identity && probe.finality && probe.fingerprint) eligible.push({ endpoint, probe });
    } catch {
      signal.throwIfAborted();
    }
  }
  const host = hostnameOf(args.env);
  const { merges } = correlateEndpoints(
    eligible.map(({ endpoint }) => ({
      endpointId: endpoint.id,
      trustDomain: endpoint.trustDomain,
      secretRef: endpoint.secretRef,
      hostname: host(endpoint),
      addresses: [],
      cnames: [],
    })),
    (input) => domainSeparatedSha256('ictt-sentinel/correlation/v1', input),
  );
  const units = collapsedIndependenceGroups(
    eligible.map((e) => e.endpoint),
    (e) => e.id,
    merges,
  );
  const readings: { witness: { endpoint: Endpoint }; reading: ChainReading }[] = [];
  let bounded = false;
  for (const unit of units) {
    for (const endpoint of unit) {
      try {
        const reading = await readChain({
          runtime,
          endpoint,
          pin: { blockNumber: BigInt(pin.blockNumber), blockHash: pin.blockHash },
          logs: args.queries.logs,
          calls: args.queries.calls,
          maxRangeBlocks: args.policy.spec.dataPath.maxLogRangeBlocks,
          maxLogs: args.maxLogs,
          signal,
        });
        readings.push({ witness: { endpoint }, reading });
        break;
      } catch (e) {
        signal.throwIfAborted();
        if (e instanceof Error && e.name === 'CollectionBoundExceeded') bounded = true;
      }
    }
  }
  const agreed = agreeOnReadings(readings, args.required);
  if (!agreed.ok)
    return `${side.label}:${bounded ? 'log-bound-exceeded' : agreed.reason === 'divergent' ? 'witness-divergence' : 'insufficient-independent-witnesses'}`;
  const witnesses = agreed.witnesses.map((w) => w.endpoint);
  const probe = eligible.find((e) => e.endpoint.id === witnesses[0]?.id)?.probe;
  if (probe === undefined) return `${side.label}:insufficient-independent-witnesses`;
  return { side, reading: agreed.reading, witnesses, probe };
};

// ------------------------------------------------------------------ decoding

const asLog = (l: RawLog): EventLog => ({ address: l.address, topics: l.topics, data: l.data });

const factsOf = <T>(reading: ChainReading, name: string, decode: (log: EventLog) => T): Fact<T>[] =>
  (reading.logs[name] ?? []).map((l) => ({
    value: decode(asLog(l)),
    at: {
      blockNumber: BigInt(l.blockNumber),
      blockHash: l.blockHash,
      txHash: l.transactionHash,
      logIndex: l.logIndex,
      blockTimestamp: BigInt(reading.blocks[l.blockNumber]?.timestamp ?? '0'),
    },
  }));

const call = (reading: ChainReading, name: string): string => {
  const v = reading.calls[name];
  if (v === undefined) throw new AbiDecodeError(`missing call ${name}`);
  return v;
};

/** Deliveries from `origin` to `destination`; others' payloads are never decoded. */
const deliveries = (
  reading: ChainReading,
  name: string,
  origin: string,
  destination: string,
): Fact<Delivery>[] =>
  factsOf(reading, name, decodeReceiveCrossChainMessage)
    .filter(
      (f) =>
        lower(f.value.originSenderAddress) === origin &&
        lower(f.value.destinationAddress) === destination,
    )
    .map((f) => ({
      value: {
        messageId: f.value.messageId,
        sourceBlockchainId: f.value.sourceBlockchainId,
        originSenderAddress: f.value.originSenderAddress,
        destinationAddress: f.value.destinationAddress,
        payload: decodeTransferrerMessage(f.value.message),
      },
      at: f.at,
    }));

const pinRef = (reading: ChainReading) => ({
  blockNumber: BigInt(reading.pin.blockNumber),
  blockHash: reading.pin.blockHash,
  timestamp: BigInt(reading.pin.timestamp),
});

// ------------------------------------------------------------------ assembly

export const collectConfigured = async (args: {
  readonly manifest: LoadedDocument<Manifest>;
  readonly policy: LoadedDocument<Policy>;
  readonly pins: readonly Pin[] | null;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runtime: Runtime;
  readonly maxLogs: number;
  readonly signal: AbortSignal;
}): Promise<CollectResult> => {
  const m = args.manifest.value;
  const policy = args.policy.value;
  if (m.spec.asset.mode !== 'canonical-erc20')
    return { status: 'unknown', reasons: ['native-collector-not-implemented'] };
  if (m.spec.baseline.state !== 'approved')
    return { status: 'unknown', reasons: ['approved-baseline-required'] };

  const sides: Side[] = deployments(m).map((deployment, i) => ({
    label: i === 0 ? 'home' : `remote:${m.spec.remotes[i - 1]?.name ?? String(i)}`,
    deployment,
    chain: deployment.chain,
    contract: deployment.contract,
    teleporter: m.spec.remotes[i - 1]?.teleporter ?? m.spec.home.teleporter,
  }));
  const required = Math.max(
    policy.spec.quorum.minIndependentTrustDomains,
    ...sides.map((s) => s.chain.quorum.independentTrustDomains),
  );

  const agreed: AgreedSide[] = [];
  const reasons: string[] = [];
  for (const [i, side] of sides.entries()) {
    const pin =
      args.pins?.find((p) => p.blockchainId === side.chain.blockchainId) ??
      (args.pins === null ? await choosePin(side, args.runtime, args.signal) : null);
    if (pin === null) {
      reasons.push(`${side.label}:no-pin`);
      continue;
    }
    const result = await collectSide({
      m,
      side,
      pin,
      queries: i === 0 ? homeQueries(m, side) : remoteQueries(m, i - 1),
      required,
      env: args.env,
      runtime: args.runtime,
      policy,
      maxLogs: args.maxLogs,
      signal: args.signal,
    });
    if (typeof result === 'string') reasons.push(result);
    else agreed.push(result);
  }
  const home = agreed[0];
  if (reasons.length > 0 || home === undefined || agreed.length !== sides.length)
    return { status: 'unknown', reasons };

  try {
    return assemble(args, m, policy, agreed, home, required);
  } catch (e) {
    if (e instanceof AbiDecodeError)
      return { status: 'unknown', reasons: ['undecodable-observation'] };
    throw e;
  }
};

const assemble = (
  args: Parameters<typeof collectConfigured>[0],
  m: Manifest,
  policy: Policy,
  agreed: readonly AgreedSide[],
  home: AgreedSide,
  required: number,
): CollectResult => {
  const deploymentId = m.metadata.name;
  const tokenHome = lower(m.spec.home.tokenHome.address);
  const homeChain = lower(m.spec.home.chain.blockchainId);
  const evmChainOf = new Map(
    agreed.map((a) => [lower(a.side.chain.blockchainId), BigInt(a.side.chain.evmChainId)]),
  );
  const digestOf = (f: Fact<unknown>, chain: string): string =>
    factDigest(evmChainOf.get(lower(chain)) ?? 0n, f.at.blockHash, f.at.txHash, f.at.logIndex);

  const hr = home.reading;
  const homeSent = factsOf(hr, 'home.tokensSent', decodeTokensSent);
  const homeUnsupported: Fact<TokensRoutedEvent>[] = [
    ...factsOf(hr, 'home.tokensAndCallSent', (l) => decodeTokensAndCall(l, 'tokensAndCallSent')),
    ...factsOf(hr, 'home.tokensRouted', decodeTokensRouted),
    ...factsOf(hr, 'home.tokensAndCallRouted', (l) =>
      decodeTokensAndCall(l, 'tokensAndCallRouted'),
    ),
  ];
  const registrations = factsOf(hr, 'home.remoteRegistered', decodeRemoteRegistered);
  const collateral = factsOf(hr, 'home.collateralAdded', decodeCollateralAdded);
  const tokenAddress = decodeAddressResult(call(hr, 'homeEscrow.tokenAddress'));
  const escrow = decodeUintResult(call(hr, 'homeEscrow.escrowBalance'));
  const homeRegistry = decodeUintResult(call(hr, 'home.registryVersion'));
  const homePin: PinnedBlock = {
    blockchainId: homeChain,
    blockNumber: BigInt(hr.pin.blockNumber),
    blockHash: hr.pin.blockHash,
  };

  const assessments: RouteAssessment[] = [];
  const traces: { trace: MessageTrace; src: string; dst: string }[] = [];
  const remotes: RemoteObservation[] = [];
  const registryVersionOf = new Map<string, number>([[homeChain, Number(homeRegistry)]]);
  const usedFacts: { fact: Fact<unknown>; chain: string }[] = [];

  m.spec.remotes.forEach((r, i) => {
    const side = agreed[i + 1];
    if (side === undefined) throw new RangeError('remote side missing');
    const rr = side.reading;
    const remoteChain = lower(r.chain.blockchainId);
    const remoteAddress = lower(r.tokenRemote.address);
    registryVersionOf.set(
      remoteChain,
      Number(decodeUintResult(call(rr, 'remote.registryVersion'))),
    );

    const homeSide: SideFacts = {
      blockchainId: homeChain,
      pin: pinRef(hr),
      sent: homeSent,
      unsupportedSends: homeUnsupported,
      delivered: deliveries(
        hr,
        `home.receiveCrossChainMessage.${String(i)}`,
        remoteAddress,
        tokenHome,
      ),
      executed: factsOf(hr, `home.messageExecuted.${String(i)}`, decodeMessageExecuted),
      failed: factsOf(hr, `home.messageExecutionFailed.${String(i)}`, decodeMessageExecutionFailed),
    };
    const remoteSide: SideFacts = {
      blockchainId: remoteChain,
      pin: pinRef(rr),
      sent: factsOf(rr, 'remote.tokensSent', decodeTokensSent),
      unsupportedSends: factsOf(rr, 'remote.tokensAndCallSent', (l) =>
        decodeTokensAndCall(l, 'tokensAndCallSent'),
      ),
      delivered: deliveries(rr, 'remote.receiveCrossChainMessage', tokenHome, remoteAddress),
      executed: factsOf(rr, 'remote.messageExecuted', decodeMessageExecuted),
      failed: factsOf(rr, 'remote.messageExecutionFailed', decodeMessageExecutionFailed),
    };
    const assessment = assessRoute(
      {
        homeBlockchainId: homeChain,
        tokenHomeAddress: tokenHome,
        remoteBlockchainId: remoteChain,
        remoteAddress,
      },
      homeSide,
      remoteSide,
      digestOf,
    );
    assessments.push(assessment);
    for (const t of assessment.messages) {
      const [src, dst] =
        t.direction === 'home-to-remote' ? [homeChain, remoteChain] : [remoteChain, homeChain];
      traces.push({ trace: t, src, dst });
      if (t.source) usedFacts.push({ fact: t.source, chain: src });
      if (t.delivery) usedFacts.push({ fact: t.delivery, chain: dst });
      for (const f of [...t.failures, ...t.executions]) usedFacts.push({ fact: f, chain: dst });
    }

    const settings = decodeRemoteSettingsResult(call(hr, `remotes.${String(i)}.settings`));
    const derived = deriveTokenMultiplierValues(
      BigInt(m.spec.asset.homeDecimals),
      BigInt(r.tokenRemote.expectedDecimals),
    );
    const registration = registrations.find(
      (f) =>
        lower(f.value.remoteBlockchainId) === remoteChain &&
        lower(f.value.remoteTokenTransferrerAddress) === remoteAddress,
    );
    const linked =
      decodeBytes32Result(call(rr, 'remote.tokenHomeBlockchainID')) === homeChain &&
      decodeAddressResult(call(rr, 'remote.tokenHomeAddress')) === tokenHome;
    remotes.push({
      remoteBlockchainId: remoteChain,
      remoteAddress,
      transferredBalance: decodeUintResult(call(hr, `remotes.${String(i)}.transferredBalance`)),
      remoteTotalSupply: decodeUintResult(call(rr, 'remote.totalSupply')),
      scale: {
        tokenMultiplier: settings.tokenMultiplier,
        multiplyOnRemote: settings.multiplyOnRemote,
        homeDecimals: m.spec.asset.homeDecimals,
        remoteDecimals: r.tokenRemote.expectedDecimals,
        established:
          settings.registered &&
          settings.collateralNeeded === 0n &&
          derived.ok &&
          derived.value.tokenMultiplier === settings.tokenMultiplier &&
          derived.value.multiplyOnRemote === settings.multiplyOnRemote &&
          registration?.value.tokenDecimals === r.tokenRemote.expectedDecimals,
      },
      homePin,
      remotePin: {
        blockchainId: remoteChain,
        blockNumber: BigInt(rr.pin.blockNumber),
        blockHash: rr.pin.blockHash,
      },
      fingerprintRecognised: home.probe.fingerprint && side.probe.fingerprint,
      tokenBehaviourCanonical: r.tokenRemote.role === 'erc20-token-remote',
      // A remote that does not point back at this home is not this route.
      routeSingleHop: assessment.unsupported.length === 0 && linked,
      initialReserveImbalance: decodeUintResult(call(rr, 'remote.initialReserveImbalance')),
    });
  });

  // Census: every registration this home ever emitted, against the approved roster.
  const approved = new Set(
    m.spec.remotes.map((r) => `${lower(r.chain.blockchainId)}/${lower(r.tokenRemote.address)}`),
  );
  const registered = new Set(
    registrations.map(
      (f) => `${lower(f.value.remoteBlockchainId)}/${lower(f.value.remoteTokenTransferrerAddress)}`,
    ),
  );
  const untrackedRemotes = [...registered].filter((k) => !approved.has(k)).sort();
  const census =
    [...approved].every((k) => registered.has(k)) && untrackedRemotes.length === 0
      ? 'complete-from-deployment-block'
      : 'partial';
  for (const f of registrations)
    if (
      approved.has(
        `${lower(f.value.remoteBlockchainId)}/${lower(f.value.remoteTokenTransferrerAddress)}`,
      )
    )
      usedFacts.push({ fact: f, chain: homeChain });
  for (const f of collateral) usedFacts.push({ fact: f, chain: homeChain });

  const nowMs = args.runtime.now();
  const nowSeconds = BigInt(Math.floor(nowMs / 1000));
  const fresh = agreed.every((a) => {
    const age = nowSeconds - BigInt(a.reading.pin.timestamp);
    return age >= 0n && age <= BigInt(policy.spec.evidence.maxAgeSeconds);
  });
  const independent = Math.min(...agreed.map((a) => a.witnesses.length));
  const homeDescriptor = SOURCE_DESCRIPTORS.find(
    (d) => d.sourcePath === m.spec.home.tokenHome.fingerprint.sourceRef?.path,
  );
  const input: ProofInput = {
    deploymentId,
    family: SUPPORTED_FAMILY,
    provenance: {
      manifestHash: args.manifest.digest,
      policyHash: args.policy.digest,
      sourceLockCommitSha: PINNED_COMMIT_SHA,
      adapterId: homeDescriptor?.adapterId ?? null,
      adapterVersion: homeDescriptor?.adapterVersion ?? null,
      ruleVersion: RULE_VERSION,
    },
    census,
    untrackedRemotes,
    cut: assessments.some((a) => a.openEdges.length > 0) ? 'open' : 'closed',
    freshness: { fresh, independentWitnessGroups: independent, requiredWitnessGroups: required },
    remotes,
    pending: assessments.flatMap((a) => a.pending),
    effects: assessments.flatMap((a) => a.effects),
    homeEscrow: {
      escrowBalance:
        lower(tokenAddress) === lower(m.spec.home.tokenHome.tokenAddress) ? escrow : null,
      homePin,
      acceptedCollateralHomeUnits: collateral.reduce((acc, f) => acc + f.value.amount, 0n),
    },
    pendingAgeLimitSeconds: PENDING_AGE_LIMIT_SECONDS,
  };
  const replayed = replayProof(input);

  // ---------------------------------------------------------------- bundle
  const votesFor = (a: AgreedSide, hash: string): WitnessVote[] =>
    a.witnesses.map((e) => ({
      endpointId: witnessId(deploymentId, e.id),
      trustDomain: e.trustDomain,
      providerGroup: e.providerGroup,
      blockchainId: lower(a.side.chain.blockchainId),
      agreedBlockHash: hash,
      agreed: true,
    }));
  const sideOf = new Map(agreed.map((a) => [lower(a.side.chain.blockchainId), a]));
  const rawFacts = new Map<
    string,
    {
      evmChainId: string;
      blockHash: string;
      txHash: string;
      logIndex: number;
      digest: string;
      chain: string;
      blockNumber: bigint;
    }
  >();
  for (const { fact, chain } of usedFacts) {
    const digest = digestOf(fact, chain);
    rawFacts.set(digest, {
      evmChainId: dec(evmChainOf.get(lower(chain)) ?? 0n),
      blockHash: fact.at.blockHash,
      txHash: fact.at.txHash,
      logIndex: fact.at.logIndex,
      digest,
      chain: lower(chain),
      blockNumber: fact.at.blockNumber,
    });
  }
  const history = new Map<string, NonNullable<BundleDraft['core']['historicalBlocks']>[number]>();
  for (const f of rawFacts.values()) {
    const a = sideOf.get(f.chain);
    if (a === undefined || f.blockNumber >= BigInt(a.reading.pin.blockNumber)) continue;
    history.set(`${f.chain}/${dec(f.blockNumber)}`, {
      blockchainId: f.chain,
      blockNumber: dec(f.blockNumber),
      blockHash: f.blockHash,
      acceptanceEvidence: `log block read identically by ${String(a.witnesses.length)} independent witnesses below the pinned block`,
      votes: votesFor(a, f.blockHash),
    });
  }

  const stateCall = (
    chain: string,
    a: AgreedSide,
    path: string,
    target: string,
    calldata: string,
    result: string,
  ): StateCallRecord => ({
    blockchainId: chain,
    target,
    observationPath: path,
    result,
    calldata,
    calldataDigest: domainSeparatedSha256('ictt-sentinel/calldata/v1', calldata),
    resultDigest: stateCallDigest(target, calldata, result),
    blockNumber: a.reading.pin.blockNumber,
    blockHash: a.reading.pin.blockHash,
    provenance: `eth_call at the pinned block; identical result from ${String(a.witnesses.length)} independent witnesses`,
  });
  const stateCalls: StateCallRecord[] = [
    stateCall(
      homeChain,
      home,
      'homeEscrow.tokenAddress',
      tokenHome,
      CALLS.getTokenAddress(),
      lower(tokenAddress),
    ),
    stateCall(
      homeChain,
      home,
      'homeEscrow.escrowBalance',
      lower(m.spec.home.tokenHome.tokenAddress),
      CALLS.balanceOf(tokenHome),
      dec(escrow),
    ),
  ];
  m.spec.remotes.forEach((r, i) => {
    const side = agreed[i + 1];
    const remote = remotes[i];
    if (side === undefined || remote === undefined) throw new RangeError('remote side missing');
    const chain = lower(r.chain.blockchainId);
    stateCalls.push(
      stateCall(
        homeChain,
        home,
        `remotes.${String(i)}.transferredBalance`,
        tokenHome,
        CALLS.getTransferredBalance(chain, remote.remoteAddress),
        dec(remote.transferredBalance ?? 0n),
      ),
      stateCall(
        chain,
        side,
        `remotes.${String(i)}.remoteTotalSupply`,
        remote.remoteAddress,
        CALLS.totalSupply(),
        dec(remote.remoteTotalSupply ?? 0n),
      ),
      stateCall(
        chain,
        side,
        `remotes.${String(i)}.initialReserveImbalance`,
        remote.remoteAddress,
        CALLS.getInitialReserveImbalance(),
        dec(remote.initialReserveImbalance),
      ),
    );
  });

  const fingerprint = (a: AgreedSide): ContractFingerprint => ({
    role: a.side.contract.role,
    blockchainId: lower(a.side.chain.blockchainId),
    runtimeCodeHash: a.probe.observedFingerprint.runtimeHash ?? '',
    address: lower(a.side.contract.address),
    implementationAddress: a.probe.observedFingerprint.implementation,
    implementationCodeHash: a.probe.observedFingerprint.implementationHash,
    proxyAdmin: a.probe.observedFingerprint.admin,
    beacon: a.probe.observedFingerprint.beacon,
    recognised: a.probe.fingerprint,
  });

  const messengerOf = (chain: string): string =>
    lower(
      chain === homeChain
        ? m.spec.home.teleporter.messengerAddress
        : (m.spec.remotes.find((r) => lower(r.chain.blockchainId) === chain)?.teleporter
            .messengerAddress ?? ''),
    );
  const messages: MessageRecord[] = traces.map(({ trace: t, src, dst }) => ({
    sourceBlockchainId: src,
    destinationBlockchainId: dst,
    teleporterMessengerAddress: messengerOf(src),
    registryProtocolVersion: registryVersionOf.get(src) ?? 0,
    messageId: t.messageId,
    state: t.state,
    timeline: [
      ...(t.source ? [{ kind: 'source-accounted', factDigest: digestOf(t.source, src) }] : []),
      ...(t.delivery ? [{ kind: 'delivered', factDigest: digestOf(t.delivery, dst) }] : []),
      ...t.failures.map((f) => ({ kind: 'execution-failed', factDigest: digestOf(f, dst) })),
      ...t.executions.map((f) => ({ kind: 'execution-succeeded', factDigest: digestOf(f, dst) })),
    ],
    sendAttempts: t.source ? 1 : 0,
    executionAttempts: t.failures.length + t.executions.length,
    envelopeIds: [t.messageId],
    economicEffectCount: t.executions.length > 0 ? 1 : 0,
  }));

  const observedAt = new Date(nowMs).toISOString();
  const draft: BundleDraft = {
    core: {
      producer: buildIdentity(),
      sourceLock: {
        commitSha: PINNED_COMMIT_SHA,
        sourceLockHash: sourceLockHash(),
        adapterId: input.provenance.adapterId ?? '',
        adapterVersion: input.provenance.adapterVersion ?? 0,
        adapterEpoch: `pinned-${PINNED_COMMIT_SHA.slice(0, 8)}`,
      },
      baseline: { manifestHash: args.manifest.digest, policyHash: args.policy.digest },
      deploymentId,
      fingerprints: agreed.map(fingerprint),
      chains: agreed.map((a) => ({
        blockchainId: lower(a.side.chain.blockchainId),
        evmChainId: String(a.side.chain.evmChainId),
        blockNumber: a.reading.pin.blockNumber,
        blockHash: a.reading.pin.blockHash,
        blockTimestamp: a.reading.pin.timestamp,
        acceptanceEvidence: a.probe.acceptanceEvidence,
        finalityBasis: a.side.chain.finality.mode,
      })),
      quorum: {
        votes: agreed.flatMap((a) => votesFor(a, a.reading.pin.blockHash)),
        independentGroups: independent,
        requiredGroups: required,
        note: 'Quorum counts independent failure domains (trust domain or provider group). It is agreement between independent readers, not a cryptographic or Byzantine guarantee: providers can share an upstream.',
      },
      rawFacts: [...rawFacts.values()]
        .map(({ evmChainId, blockHash, txHash, logIndex, digest }) => ({
          evmChainId,
          blockHash,
          txHash,
          logIndex,
          digest,
        }))
        .sort((a, b) => a.digest.localeCompare(b.digest)),
      historicalBlocks: [...history.values()].sort((a, b) =>
        a.blockchainId === b.blockchainId
          ? BigInt(a.blockNumber) < BigInt(b.blockNumber)
            ? -1
            : 1
          : a.blockchainId.localeCompare(b.blockchainId),
      ),
      stateCalls,
      census: {
        completeness: census,
        registeredRemotes: remotes.map((r) => `${r.remoteBlockchainId}/${r.remoteAddress}`),
        missingRemotes: [],
        remotesWithoutRpc: [],
      },
      messages,
      rules: [replayed.rule],
      verdict: replayed.verdict,
      completeness: {
        observedAt,
        expiresAt: new Date(nowMs + policy.spec.evidence.expiresAfterSeconds * 1000).toISOString(),
        fresh,
        missingEvidence: [],
        contradictoryEvidence: [],
      },
      assurance: {
        assuranceMode: m.spec.assuranceMode,
        assumptions: [
          'Quorum counts independent failure domains; it is not a cryptographic or Byzantine guarantee.',
          'Teleporter logs are interpreted under the pinned TeleporterMessenger ABI at the operator-declared messenger address; that contract’s runtime code is not source-locked.',
          'Observed onchain coverage at the pinned blocks, not legal recoverability.',
        ],
        exclusions: [
          'Native token remotes, custom ERC20 remotes, rebase and fee-on-transfer wrappers.',
          'Multi-hop, routed and send-and-call transfers (reported unsupported, never flattened).',
        ],
        nonGoals: [
          'No signing, custody or wallet surface.',
          'No transaction sending, retry, pause or circuit breaker.',
          'No claim of absolute solvency or proof of reserves.',
        ],
      },
      previousBundleHash: null,
      replay: { input: encodeProofInput(input), evaluation: replayed.evaluation },
    },
    presentation: { generatedAt: observedAt, locale: 'en-US', toolVersion: '0.0.0' },
  };
  const bundle = buildBundle(draft);
  // The collector holds itself to the verifier anyone else will run.
  const check = verifyBundle(bundle);
  if (!check.verified)
    return {
      status: 'unknown',
      reasons: [...new Set(check.findings.map((f) => `unverifiable:${f.detail}`))],
    };
  return { status: 'evidence', bundle };
};
