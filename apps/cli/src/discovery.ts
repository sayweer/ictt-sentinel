import { existsSync } from 'node:fs';
import {
  loadManifest,
  type LoadedDocument,
  type Manifest,
  type Policy,
} from '@ictt-sentinel/config';
import { canonicalStringify, domainSeparatedSha256 } from '@ictt-sentinel/evidence';
import { keccak256Hex } from '@ictt-sentinel/ictt-adapters';
import { writeAtomic, resolveEvidencePath } from './atomic-write.js';
import {
  bytes32,
  hexQuantity,
  object,
  readDocument,
  independentCount,
  InputError,
  type Pin,
  type Runtime,
} from './runtime.js';
import { probeDeployment, deployments } from './doctor.js';
import type { ReplayCursor } from './offline-replay.js';
import { EXIT } from './exit-codes.js';

// ITokenHome.sol @ 8fef6ef73767f4497a72d8348a0774a262e0c535, indexed chain/address.
export const REGISTRATION_TOPIC = keccak256Hex(
  new TextEncoder().encode('RemoteRegistered(bytes32,address,uint256,uint8)'),
);
interface Registration {
  blockchainId: string;
  address: string;
  collateral: string;
  decimals: number;
  blockNumber: string;
  blockHash: string;
  txHash: string;
  logIndex: string;
}
const decode = (value: unknown, home: string, from: bigint, to: bigint): Registration => {
  const log = object(value);
  const topics = log['topics'];
  const data = log['data'];
  const n = hexQuantity(log['blockNumber']);
  if (
    log['address'] !== home ||
    log['removed'] !== false ||
    n < from ||
    n > to ||
    !Array.isArray(topics) ||
    topics.length !== 3 ||
    topics[0] !== REGISTRATION_TOPIC ||
    typeof topics[2] !== 'string' ||
    !/^0x0{24}[0-9a-f]{40}$/.test(topics[2]) ||
    typeof data !== 'string' ||
    !/^0x[0-9a-f]{128}$/.test(data)
  )
    throw new InputError('Invalid registration log.');
  const decimals = BigInt(`0x${data.slice(66)}`);
  if (decimals > 77n) throw new InputError('Unsupported registration decimals.');
  return {
    blockchainId: bytes32(topics[1]),
    address: `0x${topics[2].slice(-40)}`,
    collateral: BigInt(`0x${data.slice(2, 66)}`).toString(),
    decimals: Number(decimals),
    blockNumber: n.toString(),
    blockHash: bytes32(log['blockHash']),
    txHash: bytes32(log['transactionHash']),
    logIndex: hexQuantity(log['logIndex']).toString(),
  };
};
const digest = (value: unknown) =>
  domainSeparatedSha256('ictt-sentinel/discovery-checkpoint/v1', canonicalStringify(value));

/** Each invocation commits one bounded range only after independent readers agree. */
export const discoverConfigured = async (
  loaded: LoadedDocument<Manifest>,
  policy: Policy,
  pins: readonly Pin[],
  runtime: Runtime,
  signal: AbortSignal,
  root: string,
  options: ReplayCursor,
) => {
  const m = loaded.value,
    home = m.spec.home;
  const deployment = deployments(m)[0];
  const pin = pins.find((p) => p.blockchainId === home.chain.blockchainId);
  if (!pin || !deployment) throw new InputError('Home pin required.');
  const end = BigInt(pin.blockNumber);
  const binding = digest({ manifest: loaded.digest, policy, pins, topic: REGISTRATION_TOPIC });
  let next = BigInt(m.spec.census.fromBlock);
  let registrations: Registration[] = [];
  const checkpointPath = resolveEvidencePath(root, 'discovery-checkpoint.json');
  if (options.resume) {
    if (!existsSync(checkpointPath)) throw new InputError('Checkpoint missing.');
    const raw = object(JSON.parse(readDocument(checkpointPath)));
    const { contentHash, ...core } = raw;
    if (
      contentHash !== digest(core) ||
      core['binding'] !== binding ||
      Object.keys(core).sort().join(',') !== 'binding,next,registrations,schemaVersion' ||
      core['schemaVersion'] !== 'ictt-sentinel/discovery-checkpoint/v1' ||
      typeof core['next'] !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(core['next']) ||
      !Array.isArray(core['registrations'])
    )
      throw new InputError('Checkpoint mismatch.');
    next = BigInt(core['next']);
    if (next < BigInt(m.spec.census.fromBlock) || next > end + 1n) throw new InputError();
    registrations = core['registrations'] as Registration[];
    // The checkpoint is a local resume aid, not an independently authenticated census.
    for (const r of registrations)
      if (
        !/^0x[0-9a-f]{40}$/.test(r.address) ||
        bytes32(r.blockchainId) !== r.blockchainId ||
        bytes32(r.blockHash) !== r.blockHash ||
        bytes32(r.txHash) !== r.txHash ||
        !/^(0|[1-9][0-9]*)$/.test(r.collateral) ||
        !Number.isInteger(r.decimals) ||
        r.decimals < 0 ||
        r.decimals > 77 ||
        BigInt(r.blockNumber) >= next ||
        BigInt(r.blockNumber) < BigInt(m.spec.census.fromBlock)
      )
        throw new InputError();
  }
  if (end < BigInt(home.tokenHome.deploymentBlock))
    throw new InputError('Pin precedes deployment.');
  const to =
    next + BigInt(policy.spec.dataPath.maxLogRangeBlocks) - 1n < end
      ? next + BigInt(policy.spec.dataPath.maxLogRangeBlocks) - 1n
      : end;
  const witnesses = [];
  if (next <= end) {
    for (const endpoint of home.chain.endpoints) {
      signal.throwIfAborted();
      try {
        const probe = await probeDeployment(deployment, endpoint, pin, runtime, signal);
        if (!probe.identity || !probe.finality || !probe.fingerprint || !probe.archive) continue;
        const raw = await runtime.read(
          endpoint,
          {
            op: 'logs',
            fromBlock: next,
            toBlock: to,
            address: home.tokenHome.address,
            topics: [REGISTRATION_TOPIC],
          },
          signal,
        );
        if (!Array.isArray(raw) || raw.length > options.maxFacts) continue;
        const logs = raw
          .map((v: unknown) => decode(v, home.tokenHome.address, next, to))
          .sort((a, b) =>
            BigInt(a.blockNumber) < BigInt(b.blockNumber)
              ? -1
              : BigInt(a.blockNumber) > BigInt(b.blockNumber)
                ? 1
                : BigInt(a.logIndex) < BigInt(b.logIndex)
                  ? -1
                  : 1,
          );
        if (new Set(logs.map((r) => `${r.blockHash}/${r.logIndex}`)).size !== logs.length) continue;
        for (const r of logs) {
          const block = object(
            await runtime.read(
              endpoint,
              {
                op: 'block-by-ref',
                ref: { kind: 'number', number: BigInt(r.blockNumber) },
                fullTransactions: false,
              },
              signal,
            ),
          );
          if (
            bytes32(block['hash']) !== r.blockHash ||
            hexQuantity(block['number']) !== BigInt(r.blockNumber)
          )
            throw new InputError('Historical hash disagreement.');
        }
        const after = object(
          await runtime.read(
            endpoint,
            { op: 'block-by-ref', ref: { kind: 'number', number: end }, fullTransactions: false },
            signal,
          ),
        );
        if (bytes32(after['hash']) !== pin.blockHash) continue;
        witnesses.push({ endpoint, logs });
      } catch {
        signal.throwIfAborted();
      }
    }
    const required = Math.max(
      home.chain.quorum.independentTrustDomains,
      policy.spec.quorum.minIndependentTrustDomains,
    );
    if (
      independentCount(witnesses.map((w) => w.endpoint)) < required ||
      new Set(witnesses.map((w) => canonicalStringify(w.logs))).size !== 1
    )
      return {
        complete: false,
        checkpointAdvanced: false,
        missing: ['independent-registration-quorum-or-log-bound'],
        exitCode: EXIT.requiredUnknown,
      };
    registrations.push(...(witnesses[0]?.logs ?? []));
    next = to + 1n;
    const checkpoint = {
      schemaVersion: 'ictt-sentinel/discovery-checkpoint/v1',
      binding,
      next: next.toString(),
      registrations,
    };
    signal.throwIfAborted();
    writeAtomic(
      root,
      'discovery-checkpoint.json',
      JSON.stringify({ ...checkpoint, contentHash: digest(checkpoint) }),
    );
  }
  const byRemote = new Map(registrations.map((r) => [`${r.blockchainId}/${r.address}`, r]));
  if (byRemote.size !== registrations.length)
    throw new InputError('Conflicting registration history.');
  const approved = new Map(
    m.spec.remotes.map((r) => [`${r.chain.blockchainId}/${r.tokenRemote.address}`, r]),
  );
  const complete = next > end;
  const added = [...byRemote.keys()].filter((k) => !approved.has(k));
  const missing = [...approved.keys()].filter((k) => !byRemote.has(k));
  const changed = [...byRemote]
    .filter(
      ([k, r]) => approved.has(k) && approved.get(k)?.tokenRemote.expectedDecimals !== r.decimals,
    )
    .map(([key, r]) => ({ key, observedDecimals: r.decimals }));
  const candidate = {
    ...m,
    spec: {
      ...m.spec,
      remotes: m.spec.remotes.map((r) => ({
        ...r,
        tokenRemote: {
          ...r.tokenRemote,
          expectedDecimals:
            byRemote.get(`${r.chain.blockchainId}/${r.tokenRemote.address}`)?.decimals ??
            r.tokenRemote.expectedDecimals,
        },
      })),
      census: {
        ...m.spec.census,
        completeness:
          complete && added.length === 0 && missing.length === 0
            ? 'complete-from-deployment-block'
            : 'partial',
      },
      baseline: {
        state: 'candidate',
        fieldPolicies: m.spec.baseline.fieldPolicies,
        discovery: {
          discoveredAt: new Date(runtime.now()).toISOString(),
          tool: 'ictt-sentinel',
          atBlock: pin.blockNumber,
        },
      },
    },
  };
  loadManifest(JSON.stringify(candidate));
  const result = {
    complete,
    fromBlock: m.spec.census.fromBlock,
    scannedThrough: (next - 1n).toString(),
    pin,
    baselineDigest: loaded.digest,
    approvedManifestModified: false,
    candidateRequiresReview: true,
    candidateRemotes: [...byRemote.values()].map((r) => ({ ...r, trusted: false })),
    diff: { added, missing, changed },
    unresolvedRemoteConfiguration: added,
    note: 'New remotes need operator-supplied chain identity, deployment block, endpoints and fingerprint before inclusion. Missing observations are not removals. Checkpoint integrity is local tamper evidence, not RPC authentication.',
    exitCode: EXIT.requiredUnknown,
  };
  signal.throwIfAborted();
  writeAtomic(root, 'candidate.manifest.json', `${JSON.stringify(candidate, null, 2)}\n`);
  writeAtomic(root, 'discovery.json', `${JSON.stringify(result, null, 2)}\n`);
  return result;
};
