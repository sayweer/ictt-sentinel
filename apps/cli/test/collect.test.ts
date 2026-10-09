import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadManifest, loadPolicy, type Endpoint, type Manifest } from '@ictt-sentinel/config';
import { verifyBundle, type EvidenceBundle } from '@ictt-sentinel/evidence';
import { CALLS, EVENT_TOPICS, PINNED_COMMIT_SHA, codeHash } from '@ictt-sentinel/ictt-adapters';
import type { ReadOperation } from '@ictt-sentinel/rpc-quorum';
import { runAsync } from '../src/configured.js';
import { deployments } from '../src/doctor.js';
import type { Runtime } from '../src/runtime.js';

/**
 * The collector against a simulated two-chain ICTT deployment.
 *
 * Logs are ABI-encoded exactly as the pinned contracts emit them, so the whole
 * path runs for real: witness probes, bounded log scans, decoding, the route
 * model, the canonical ERC20 engine, the evidence bundle, the offline verifier
 * and finally the existing `check` command against the written bundle.
 */

const HOME = `0x${'aa'.repeat(32)}`;
const REMOTE = `0x${'bb'.repeat(32)}`;
const TOKEN_HOME = `0x${'11'.repeat(20)}`;
const TOKEN_REMOTE = `0x${'22'.repeat(20)}`;
const TOKEN = `0x${'33'.repeat(20)}`;
const MESSENGER = '0x253b2784c75e510dd0ff1da844684a1ac0aa5fcf';
const REGISTRY_HOME = `0x${'44'.repeat(20)}`;
const REGISTRY_REMOTE = `0x${'45'.repeat(20)}`;
const CODE = '0x6000';
const NOW_S = 1_800_000_000n;
const PIN = 20n;
const E12 = 10n ** 12n;

const w = (v: bigint | number | string): string =>
  typeof v === 'string'
    ? v.replace(/^0x/, '').padStart(64, '0')
    : BigInt(v).toString(16).padStart(64, '0');
const id = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
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

interface World {
  logs: Log[];
  remoteSupply: bigint;
  transferred: bigint;
  escrow: bigint;
}

/** A healthy history: one delivered send each way, one home send still in flight. */
const healthy = (): World => ({
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

const setup = (world: World, tamper?: (endpoint: Endpoint, logs: unknown[]) => unknown[]) => {
  const root = mkdtempSync(join(tmpdir(), 'ictt-collect-'));
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
  const paths = {
    manifest: join(root, 'manifest.json'),
    policy: join(root, 'policy.json'),
    out: join(root, 'out'),
  };
  writeFileSync(paths.manifest, manifestText);
  writeFileSync(paths.policy, JSON.stringify(policy));
  const env: Record<string, string> = Object.fromEntries([
    ...deployments(m).flatMap((d) =>
      d.chain.endpoints.map((e) => [e.secretRef, `https://${e.id}.rpc.test/`]),
    ),
    ['DATABASE_URL', 'present'],
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
  const runtime: Runtime = {
    now: () => Number(NOW_S) * 1000,
    database: () => Promise.resolve(true),
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
  const invoke = async (args: string[]) => {
    let stdout = '';
    const code = await runAsync(
      {
        argv: [...args, '--manifest', paths.manifest, '--policy', paths.policy, '--json'],
        env,
        evidenceDir: paths.out,
        version: '0.0.0',
        isTty: false,
        writer: {
          out: (text: string) => {
            stdout += text;
          },
          err: () => undefined,
        },
      },
      new AbortController().signal,
      runtime,
    );
    return { code, result: JSON.parse(stdout) as Record<string, unknown> };
  };
  return { invoke, paths };
};

const evidence = (out: string): EvidenceBundle =>
  JSON.parse(readFileSync(join(out, 'collected.evidence.json'), 'utf8')) as EvidenceBundle;

describe('live collection against a simulated deployment', () => {
  it('reconciles a healthy route and writes evidence the verifier and check accept', async () => {
    const f = setup(healthy());
    const r = await f.invoke(['collect', '--max-facts', '1000']);
    expect(r.result['reasons']).toBeUndefined();
    expect(r.code).toBe(0);
    const bundle = evidence(f.paths.out);
    expect(verifyBundle(bundle).verified).toBe(true);
    expect(bundle.core.verdict.protocolStatus).toBe('OK');
    expect(bundle.core.verdict.reasonCodes).toContain('ACC-A00-RECONCILED');
    expect(bundle.core.messages.map((m) => m.state).sort()).toEqual([
      'EXECUTED_SUCCESS',
      'EXECUTED_SUCCESS',
      'SOURCE_ACCOUNTED',
    ]);
    const check = await f.invoke([
      'check',
      '--file',
      join(f.paths.out, 'collected.evidence.json'),
      '--offline',
    ]);
    expect(check.code).toBe(0);
  });

  it('reports remote supply above home accounting as CRITICAL', async () => {
    const world = healthy();
    world.remoteSupply = 1400n * E12;
    const r = await setup(world).invoke(['collect', '--max-facts', '1000']);
    expect(r.code).toBe(2);
  });

  it('is UNKNOWN when one witness returns a different history', async () => {
    const f = setup(healthy(), (endpoint, logs) =>
      endpoint.id.endsWith('secondary') || endpoint.trustDomain === 'provider-1'
        ? logs.slice(1)
        : logs,
    );
    const r = await f.invoke(['collect', '--max-facts', '1000']);
    expect(r.code).toBe(3);
    expect(r.result['reasons']).toEqual(
      expect.arrayContaining([expect.stringContaining('witness-divergence')]),
    );
  });

  it('is UNKNOWN when an execution inside the cut has its source after the home pin', async () => {
    const world = healthy();
    // Message 1's home send moves past the home pin; remote still executed it.
    world.logs = world.logs.map((l) =>
      l.topics[1] === id(1) && l.chain === HOME ? { ...l, block: PIN + 1n } : l,
    );
    world.transferred = 300n * E12;
    const f = setup(world);
    const r = await f.invoke(['collect', '--max-facts', '1000']);
    expect(r.code).toBe(3);
    const bundle = evidence(f.paths.out);
    expect(verifyBundle(bundle).verified).toBe(true);
    expect(bundle.core.verdict.reasonCodes).toContain('ACC-I05-CAUSAL-CUT-OPEN');
  });

  it('refuses to scan more history than the bound allows', async () => {
    const r = await setup(healthy()).invoke(['collect', '--max-facts', '2']);
    expect(r.code).toBe(3);
    expect(r.result['reasons']).toEqual(
      expect.arrayContaining([expect.stringContaining('log-bound-exceeded')]),
    );
  });
});
