import { readFileSync } from 'node:fs';
import {
  loadManifest,
  loadPolicy,
  type Endpoint,
  type LoadedDocument,
  type Manifest,
  type Policy,
} from '@ictt-sentinel/config';
import { CALLS, EVENT_TOPICS, PINNED_COMMIT_SHA, codeHash } from '@ictt-sentinel/ictt-adapters';
import type { ReadOperation } from '@ictt-sentinel/rpc-quorum';
import { deployments, type ChainReader } from '../src/index.js';

/**
 * A simulated two-chain ICTT deployment, shared by the collector, CLI and agent
 * tests.
 *
 * Logs are ABI-encoded exactly as the pinned contracts emit them and state reads
 * answer the pinned getters, so whatever reads this world runs the whole path for
 * real: witness probes, bounded log scans, decoding, the route model, the
 * engine and the evidence verifier.
 */

export const HOME = `0x${'aa'.repeat(32)}`;
export const REMOTE = `0x${'bb'.repeat(32)}`;
const TOKEN_HOME = `0x${'11'.repeat(20)}`;
const TOKEN_REMOTE = `0x${'22'.repeat(20)}`;
const TOKEN = `0x${'33'.repeat(20)}`;
const MESSENGER = '0x253b2784c75e510dd0ff1da844684a1ac0aa5fcf';
const REGISTRY_HOME = `0x${'44'.repeat(20)}`;
const REGISTRY_REMOTE = `0x${'45'.repeat(20)}`;
const CODE = '0x6000';
export const NOW_S = 1_800_000_000n;
export const PIN = 20n;
export const E12 = 10n ** 12n;

const w = (v: bigint | number | string): string =>
  typeof v === 'string'
    ? v.replace(/^0x/, '').padStart(64, '0')
    : BigInt(v).toString(16).padStart(64, '0');
export const id = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const blockHash = (chain: string, n: bigint): string =>
  `0x${w(n).slice(0, 62)}${chain.slice(2, 4)}`;
const ts = (n: bigint): bigint => NOW_S - 60n + n;

interface Log {
  readonly chain: string;
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly block: bigint;
  readonly logIndex: number;
}

const transferrerMessage = (amount: bigint, type = 1): string =>
  `${w(32)}${w(type)}${w(64)}${w(64)}${w(`0x${'98'.repeat(20)}`)}${w(amount)}`;

/** `ReceiveCrossChainMessage` data: rewardRedeemer, struct offset, TeleporterMessage. */
const received = (
  origin: string,
  destChain: string,
  dest: string,
  amount: bigint,
  type = 1,
): string => {
  const message = transferrerMessage(amount, type);
  return `0x${w(`0x${'77'.repeat(20)}`)}${w(64)}${w(1)}${w(origin)}${w(destChain)}${w(dest)}${w(200000)}${w(0x100)}${w(0x120)}${w(0x140)}${w(0)}${w(0)}${w(message.length / 2)}${message}`;
};

const tokensSent = (destChain: string, dest: string, amount: bigint): string =>
  `0x${w(destChain)}${w(dest)}${w(`0x${'98'.repeat(20)}`)}${w(0)}${w(0)}${w(0)}${w(200000)}${w(0)}${w(amount)}`;

export interface World {
  logs: Log[];
  remoteSupply: bigint;
  transferred: bigint;
  escrow: bigint;
}

/** A healthy history: one delivered send each way, one home send still in flight. */
export const healthy = (): World => ({
  logs: [
    {
      chain: HOME,
      address: TOKEN_HOME,
      topics: [EVENT_TOPICS.remoteRegistered, REMOTE, `0x${w(TOKEN_REMOTE)}`],
      data: `0x${w(0)}${w(18)}`,
      block: 2n,
      logIndex: 0,
    },
    // home -> remote, message 1: 1000 delivered and executed at remote block 7.
    {
      chain: HOME,
      address: TOKEN_HOME,
      topics: [EVENT_TOPICS.tokensSent, id(1), `0x${w(`0x${'99'.repeat(20)}`)}`],
      data: tokensSent(REMOTE, TOKEN_REMOTE, 1000n * E12),
      block: 5n,
      logIndex: 0,
    },
    {
      chain: REMOTE,
      address: MESSENGER,
      topics: [
        EVENT_TOPICS.receiveCrossChainMessage,
        id(1),
        HOME,
        `0x${w(`0x${'66'.repeat(20)}`)}`,
      ],
      data: received(TOKEN_HOME, REMOTE, TOKEN_REMOTE, 1000n * E12),
      block: 7n,
      logIndex: 0,
    },
    {
      chain: REMOTE,
      address: MESSENGER,
      topics: [EVENT_TOPICS.messageExecuted, id(1), HOME],
      data: '0x',
      block: 7n,
      logIndex: 2,
    },
    // home -> remote, message 2: 500 still in flight.
    {
      chain: HOME,
      address: TOKEN_HOME,
      topics: [EVENT_TOPICS.tokensSent, id(2), `0x${w(`0x${'99'.repeat(20)}`)}`],
      data: tokensSent(REMOTE, TOKEN_REMOTE, 500n * E12),
      block: 8n,
      logIndex: 0,
    },
    // remote -> home, message 3: 200 burned at remote block 9, executed at home block 10.
    {
      chain: REMOTE,
      address: TOKEN_REMOTE,
      topics: [EVENT_TOPICS.tokensSent, id(3), `0x${w(`0x${'97'.repeat(20)}`)}`],
      data: tokensSent(HOME, TOKEN_HOME, 200n * E12),
      block: 9n,
      logIndex: 0,
    },
    {
      chain: HOME,
      address: MESSENGER,
      topics: [
        EVENT_TOPICS.receiveCrossChainMessage,
        id(3),
        REMOTE,
        `0x${w(`0x${'66'.repeat(20)}`)}`,
      ],
      data: received(TOKEN_REMOTE, HOME, TOKEN_HOME, 200n * E12),
      block: 10n,
      logIndex: 0,
    },
    {
      chain: HOME,
      address: MESSENGER,
      topics: [EVENT_TOPICS.messageExecuted, id(3), REMOTE],
      data: '0x',
      block: 10n,
      logIndex: 2,
    },
  ],
  // D = 1000 + 500 - 200 = 1300, S = 1000 - 200 = 800, D - S = 500 = in flight.
  transferred: 1300n * E12,
  remoteSupply: 800n * E12,
  escrow: 1300n,
});

export const simulate = (
  world: World,
  tamper?: (endpoint: Endpoint, logs: unknown[]) => unknown[],
) => {
  const m: Manifest = loadManifest(
    readFileSync('config/deployments/example.ictt.yml', 'utf8'),
  ).value;
  m.metadata.name = 'collect-fixture';
  m.spec.home.tokenHome.address = TOKEN_HOME;
  m.spec.home.tokenHome.tokenAddress = TOKEN;
  m.spec.home.tokenHome.deploymentBlock = '1';
  m.spec.census.fromBlock = '1';
  m.spec.home.teleporter.messengerAddress = MESSENGER;
  m.spec.home.teleporter.registryAddress = REGISTRY_HOME;
  const remote = m.spec.remotes[0]!;
  remote.tokenRemote.address = TOKEN_REMOTE;
  remote.tokenRemote.deploymentBlock = '1';
  remote.tokenRemote.expectedDecimals = 18;
  remote.teleporter.messengerAddress = MESSENGER;
  remote.teleporter.registryAddress = REGISTRY_REMOTE;
  deployments(m).forEach((d, i) => {
    d.chain.blockchainId = i === 0 ? HOME : REMOTE;
    d.chain.evmChainId = i === 0 ? 99001 : 99002;
    d.chain.genesisHash = blockHash(d.chain.blockchainId, 0n);
    delete d.chain.trustedCheckpoint;
    d.chain.finality = {
      mode: 'settled-quorum',
      acceptedStateQueries: 'unknown',
      maxLagSeconds: 3600,
    };
    d.chain.endpoints = d.chain.endpoints.slice(0, 2).map((e, k) => ({
      ...e,
      trustDomain: `provider-${String(k)}`,
      providerGroup: `group-${String(k)}`,
      archiveDepth: 'full',
    }));
    d.contract.proxy = { kind: 'none' };
    d.contract.fingerprint = {
      runtimeCodeHash: codeHash(CODE),
      allowedImplementationHashes: [],
      onUnknownFingerprint: 'fail-closed',
      sourceRef: {
        repository: 'ava-labs/icm-services',
        commitSha: PINNED_COMMIT_SHA,
        path: `icm-contracts/avalanche/ictt/${i === 0 ? 'TokenHome/ERC20TokenHome' : 'TokenRemote/ERC20TokenRemote'}.sol`,
      },
    };
  });
  const manifestText = JSON.stringify(m);
  const policy = loadPolicy(readFileSync('config/policies/default.yml', 'utf8')).value;
  policy.spec.dataPath.maxRetries = 0;
  policy.spec.dataPath.maxLogRangeBlocks = 7;
  const policyText = JSON.stringify(policy);
  const env: Record<string, string> = Object.fromEntries([
    ...deployments(m).flatMap((d) =>
      d.chain.endpoints.map((e) => [e.secretRef, `https://${e.id}.rpc.test/`]),
    ),
  ]);

  const chainOf = (e: Endpoint) =>
    m.spec.home.chain.endpoints.some((x) => x.id === e.id) ? HOME : REMOTE;
  const calls = (chain: string): Record<string, string> =>
    chain === HOME
      ? {
          [`${TOKEN_HOME}:${CALLS.getTokenAddress()}`]: `0x${w(TOKEN)}`,
          [`${TOKEN}:${CALLS.balanceOf(TOKEN_HOME)}`]: `0x${w(world.escrow)}`,
          [`${REGISTRY_HOME}:${CALLS.getVersionFromAddress(MESSENGER)}`]: `0x${w(1)}`,
          [`${TOKEN_HOME}:${CALLS.getTransferredBalance(REMOTE, TOKEN_REMOTE)}`]: `0x${w(world.transferred)}`,
          [`${TOKEN_HOME}:${CALLS.getRemoteTokenTransferrerSettings(REMOTE, TOKEN_REMOTE)}`]: `0x${w(1)}${w(0)}${w(E12)}${w(1)}`,
        }
      : {
          [`${TOKEN_REMOTE}:${CALLS.totalSupply()}`]: `0x${w(world.remoteSupply)}`,
          [`${TOKEN_REMOTE}:${CALLS.getInitialReserveImbalance()}`]: `0x${w(0)}`,
          [`${TOKEN_REMOTE}:${CALLS.getTokenHomeBlockchainID()}`]: `0x${w(HOME)}`,
          [`${TOKEN_REMOTE}:${CALLS.getTokenHomeAddress()}`]: `0x${w(TOKEN_HOME)}`,
          [`${REGISTRY_REMOTE}:${CALLS.getVersionFromAddress(MESSENGER)}`]: `0x${w(1)}`,
        };
  const block = (chain: string, n: bigint) => ({
    number: `0x${n.toString(16)}`,
    hash: blockHash(chain, n),
    parentHash: blockHash(chain, n - 1n),
    timestamp: `0x${ts(n).toString(16)}`,
  });
  const reader: ChainReader = {
    now: () => Number(NOW_S) * 1000,
    read: (endpoint: Endpoint, op: ReadOperation) => {
      const chain = chainOf(endpoint);
      const answer = (): unknown => {
        switch (op.op) {
          case 'evm-chain-id':
            return `0x${(chain === HOME ? 99001 : 99002).toString(16)}`;
          case 'network-version':
            return '1';
          case 'warp-blockchain-id':
            return chain;
          case 'block-by-ref':
            return block(chain, op.ref.kind === 'number' ? op.ref.number : PIN);
          case 'code':
            return CODE;
          case 'storage-slot':
            return `0x${w(0)}`;
          case 'call': {
            const r = calls(chain)[`${op.to}:${op.data}`];
            if (r === undefined) throw new Error('unexpected call');
            return r;
          }
          case 'logs': {
            const logs = world.logs
              .filter(
                (l) =>
                  l.chain === chain &&
                  l.block >= op.fromBlock &&
                  l.block <= op.toBlock &&
                  (op.address === undefined || l.address === op.address) &&
                  (op.topics ?? []).every((t, i) => t === null || l.topics[i] === t),
              )
              .map((l) => ({
                address: l.address,
                topics: l.topics,
                data: l.data,
                blockNumber: `0x${l.block.toString(16)}`,
                blockHash: blockHash(chain, l.block),
                transactionHash: id(Number(l.block) * 1000 + l.logIndex),
                logIndex: `0x${l.logIndex.toString(16)}`,
                removed: false,
              }));
            return tamper ? tamper(endpoint, logs) : logs;
          }
          // Operations the collector must not need. Listed rather than swept
          // into `default`, so a new read operation breaks this fake loudly.
          case 'head-block-number':
          case 'transaction-receipt':
          case 'native-minter-role':
            throw new Error(`unexpected operation ${op.op}`);
        }
      };
      return Promise.resolve(answer());
    },
  };
  const manifest: LoadedDocument<Manifest> = loadManifest(manifestText);
  const loadedPolicy: LoadedDocument<Policy> = loadPolicy(policyText);
  return { manifest, policy: loadedPolicy, manifestText, policyText, env, reader };
};
