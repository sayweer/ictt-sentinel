import { finalityBasisStands } from '@ictt-sentinel/domain';
import type { Endpoint, Manifest } from '@ictt-sentinel/config';
import { domainSeparatedSha256, endpointPseudonym } from '@ictt-sentinel/evidence';
import {
  codeHash,
  EIP1967_SLOTS,
  PINNED_COMMIT_SHA,
  SOURCE_DESCRIPTORS,
} from '@ictt-sentinel/ictt-adapters';
import type { ReadOperation } from '@ictt-sentinel/rpc-quorum';
import { bytes32, hexQuantity, object } from './values.js';

/**
 * What a reader must provide: query-only reads and a clock. The CLI runtime and
 * the agent's endpoint reader both satisfy it; neither can send anything.
 */
export interface ChainReader {
  read(endpoint: Endpoint, operation: ReadOperation, signal: AbortSignal): Promise<unknown>;
  now(): number;
}

/** An explicit chain position. Number AND hash. */
export interface ChainPin {
  readonly blockchainId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
}

/** Every approved contract with its chain, home first. */
export const deployments = (manifest: Manifest) => [
  { chain: manifest.spec.home.chain, contract: manifest.spec.home.tokenHome },
  ...manifest.spec.remotes.map((r) => ({ chain: r.chain, contract: r.tokenRemote })),
];

/** A stable pseudonym for an endpoint. A URL never appears in evidence. */
export const witnessId = (deploymentId: string, endpointId: string): string =>
  endpointPseudonym(
    (s) => domainSeparatedSha256('ictt-sentinel/endpoint/v1', s),
    deploymentId,
    endpointId,
  );

const slotAddress = (value: unknown): string | null => {
  const word = bytes32(value);
  if (!/^0x0{24}/.test(word)) throw new Error('Non-address slot.');
  return /^0x0{64}$/.test(word) ? null : `0x${word.slice(-40)}`;
};

export const probeDeployment = async (
  deployment: ReturnType<typeof deployments>[number],
  endpoint: Endpoint,
  pin: ChainPin,
  runtime: ChainReader,
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
  // After ACP-194 the accepted-quorum basis no longer stands for executed state
  // on this chain, however well the endpoint behaves. settled-quorum is what
  // replaces it, and it rests on the finalized-tag probe below alone.
  const settled = chain.finality.mode === 'settled-quorum';
  const superseded = !finalityBasisStands(
    chain.finality.mode,
    { evmChainId: BigInt(chain.evmChainId), blockchainId: chain.blockchainId },
    hexQuantity(initial['timestamp']),
  );
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
      (settled || chain.finality.acceptedStateQueries === 'accepted-only') &&
      !superseded;
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
    acceptanceEvidence: superseded
      ? 'superseded-by-acp-194'
      : !finality
        ? 'unproven'
        : settled
          ? 'finalized-tag-probe; explicit-number-hash-recheck; settled-quorum'
          : 'finalized-tag-probe; explicit-number-hash-recheck; operator-accepted-only-attestation',
  };
};
