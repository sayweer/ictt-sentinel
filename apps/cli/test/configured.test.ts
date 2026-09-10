import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadManifest, loadPolicy, type Manifest } from '@ictt-sentinel/config';
import {
  buildBundle,
  encodeProofInput,
  decodeProofInput,
  replayProof,
  verifyBundle,
} from '@ictt-sentinel/evidence';
import { quickstartBundleDraft } from '@ictt-sentinel/testkit';
import { codeHash, PINNED_COMMIT_SHA } from '@ictt-sentinel/ictt-adapters';
import { runAsync } from '../src/configured.js';
import { sourceLockHash } from '../src/identity.js';
import { deployments, witnessId } from '../src/doctor.js';
import { createRuntime, independentCount, type Runtime } from '../src/runtime.js';
import type { Endpoint } from '@ictt-sentinel/config';
import type { ReadOperation } from '@ictt-sentinel/rpc-quorum';
import { REGISTRATION_TOPIC } from '../src/discovery.js';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const hash = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const quantity = (n: bigint) => `0x${n.toString(16)}`;
const setup = (scenario: 'healthy' | 'deficit' = 'healthy') => {
  const root = mkdtempSync(join(tmpdir(), 'ictt-configured-'));
  const draft = quickstartBundleDraft(scenario);
  const m = loadManifest(readFileSync('config/deployments/example.ictt.yml', 'utf8')).value;
  m.metadata.name = draft.core.deploymentId;
  m.spec.census.fromBlock = '1';
  deployments(m).forEach((d, i) => {
    const c = draft.core.chains[i]!;
    const f = draft.core.fingerprints[i]!;
    d.chain.blockchainId = c.blockchainId;
    d.chain.evmChainId = Number(c.evmChainId);
    d.chain.genesisHash = hash(0n);
    delete d.chain.trustedCheckpoint;
    // Align each chain's endpoints with the witnesses the fixture bundle
    // records for THAT chain. The example manifest's remote endpoints are
    // operator-self-hosted/provider-beta while the fixture votes come from
    // provider-alpha/provider-beta, so without this the trustDomain lookup
    // below has nothing to find.
    const chainVotes = draft.core.quorum.votes.filter((v) => v.blockchainId === c.blockchainId);
    d.chain.endpoints = d.chain.endpoints.slice(0, chainVotes.length).map((e, k) => ({
      ...e,
      archiveDepth: 'full',
      trustDomain: chainVotes[k]!.trustDomain,
      providerGroup: chainVotes[k]!.providerGroup,
    }));
    d.contract.deploymentBlock = '1';
    d.contract.address = f.address;
    d.contract.proxy = { kind: 'none' };
    d.contract.fingerprint = {
      runtimeCodeHash: codeHash('0x6000'),
      allowedImplementationHashes: [],
      onUnknownFingerprint: 'fail-closed',
      sourceRef: {
        repository: 'ava-labs/icm-services',
        commitSha: PINNED_COMMIT_SHA,
        path: `icm-contracts/avalanche/ictt/${i === 0 ? 'TokenHome/ERC20TokenHome' : 'TokenRemote/ERC20TokenRemote'}.sol`,
      },
    };
  });
  m.spec.remotes[0]!.tokenRemote.expectedDecimals = 18;
  const manifestText = JSON.stringify(m);
  const manifest = loadManifest(manifestText);
  const p = loadPolicy(readFileSync('config/policies/default.yml', 'utf8')).value;
  p.spec.dataPath.maxRetries = 0;
  p.spec.dataPath.requestTimeoutMs = 100;
  p.spec.dataPath.maxLogRangeBlocks = 50;
  const policyText = JSON.stringify(p),
    policy = loadPolicy(policyText);
  const old = decodeProofInput(draft.core.replay.input);
  const input = {
    ...old,
    provenance: { ...old.provenance, manifestHash: manifest.digest, policyHash: policy.digest },
  };
  const replayed = replayProof(input);
  const bundle = buildBundle({
    ...draft,
    core: {
      ...draft.core,
      sourceLock: { ...draft.core.sourceLock, sourceLockHash: sourceLockHash() },
      baseline: { manifestHash: manifest.digest, policyHash: policy.digest },
      chains: draft.core.chains.map((c) => ({ ...c, blockTimestamp: String(NOW / 1000 - 1) })),
      fingerprints: draft.core.fingerprints.map((f) => ({
        ...f,
        runtimeCodeHash: codeHash('0x6000'),
        // The manifest above declares `proxy: { kind: 'none' }`, so the observed
        // fingerprints must describe a non-proxy deployment too. Leaving the
        // fixture's proxy fields in place would be an approved-baseline
        // mismatch - correctly refused by the gate, but not what this test is
        // exercising.
        implementationAddress: null,
        implementationCodeHash: null,
        proxyAdmin: null,
        beacon: null,
      })),
      quorum: {
        ...draft.core.quorum,
        votes: draft.core.quorum.votes.map((v) => {
          const d = deployments(m).find((d) => d.chain.blockchainId === v.blockchainId)!;
          const ep = d.chain.endpoints.find((e) => e.trustDomain === v.trustDomain)!;
          return { ...v, endpointId: witnessId(m.metadata.name, ep.id) };
        }),
      },
      replay: { input: encodeProofInput(input), evaluation: replayed.evaluation },
      rules: [replayed.rule],
      verdict: replayed.verdict,
    },
  });
  expect(verifyBundle(bundle).verified).toBe(true);
  const pins = bundle.core.chains.map(({ blockchainId, blockNumber, blockHash }) => ({
    blockchainId,
    blockNumber,
    blockHash,
  }));
  const paths = {
    manifest: join(root, 'manifest.json'),
    policy: join(root, 'policy.json'),
    pins: join(root, 'pins.json'),
    file: join(root, 'input.json'),
    out: join(root, 'out'),
  };
  writeFileSync(paths.manifest, manifestText);
  writeFileSync(paths.policy, policyText);
  writeFileSync(paths.pins, JSON.stringify(pins));
  writeFileSync(paths.file, JSON.stringify(bundle));
  const env: Record<string, string> = Object.fromEntries([
    ...deployments(m).flatMap((d) => d.chain.endpoints.map((e) => [e.secretRef, 'present'])),
    ['DATABASE_URL', 'present'],
  ] as [string, string][]);
  const readSync = (endpoint: Endpoint, op: ReadOperation): unknown => {
    const d = deployments(m).find((d) => d.chain.endpoints.some((e) => e.id === endpoint.id))!;
    const pin = pins.find((p) => p.blockchainId === d.chain.blockchainId)!;
    switch (op.op) {
      case 'evm-chain-id':
        return quantity(BigInt(d.chain.evmChainId));
      case 'network-version':
        return String(d.chain.networkId);
      case 'warp-blockchain-id':
        return d.chain.blockchainId;
      case 'block-by-ref': {
        const number = op.ref.kind === 'number' ? op.ref.number : BigInt(pin.blockNumber);
        return {
          number: quantity(number),
          hash: hash(number),
          timestamp: quantity(BigInt(NOW / 1000 - 1)),
        };
      }
      case 'code':
        return '0x6000';
      case 'storage-slot':
        return hash(0n);
      case 'logs': {
        if (op.topics === undefined || op.fromBlock > 2n || op.toBlock < 2n) return [];
        return [
          {
            address: m.spec.home.tokenHome.address,
            removed: false,
            blockNumber: '0x2',
            blockHash: hash(2n),
            transactionHash: hash(7n),
            logIndex: '0x0',
            topics: [
              REGISTRATION_TOPIC,
              m.spec.remotes[0]!.chain.blockchainId,
              `0x${m.spec.remotes[0]!.tokenRemote.address.slice(2).padStart(64, '0')}`,
            ],
            data: `0x${'0'.repeat(64)}${(18).toString(16).padStart(64, '0')}`,
          },
        ];
      }
      // Operations this fake deliberately does not serve. Listed rather than
      // swept into `default`, so adding a read operation upstream breaks this
      // switch instead of silently returning undefined here.
      case 'head-block-number':
      case 'transaction-receipt':
      case 'call':
      case 'native-minter-role':
      default:
        throw new Error('Unexpected domain operation.');
    }
  };
  const runtime: Runtime = {
    now: () => NOW,
    // The fake resolves immediately; marking it `async` with nothing to await
    // would only hide that.
    database: () => Promise.resolve(true),
    read: (endpoint, op) => Promise.resolve(readSync(endpoint, op)),
  };
  const invoke = async (args: string[], rt = runtime, signal = new AbortController().signal) => {
    let stdout = '',
      stderr = '';
    const code = await runAsync(
      {
        argv: [...args, '--manifest', paths.manifest, '--policy', paths.policy, '--json'],
        env,
        evidenceDir: paths.out,
        version: '0.0.0',
        isTty: false,
        writer: {
          out: (s) => {
            stdout += s;
          },
          err: (s) => {
            stderr += s;
          },
        },
      },
      signal,
      rt,
    );
    return { code, result: JSON.parse(stdout) as Record<string, unknown>, stdout, stderr };
  };
  return { root, paths, manifest, policy, bundle, pins, runtime, env, invoke };
};

describe('configured offline vertical', () => {
  it.each([
    ['healthy', 0],
    ['deficit', 2],
  ] as const)('binds real parsed manifest/policy and replays %s', async (scenario, code) => {
    const f = setup(scenario);
    const r = await f.invoke([
      'check',
      '--file',
      f.paths.file,
      '--offline',
      '--pins',
      f.paths.pins,
    ]);
    expect(r.code).toBe(code);
    expect(r.result['historical']).toBe(true);
    expect(r.stderr).toBe('');
    const exported = await f.invoke(['evidence', 'export', '--file', f.paths.file, '--offline']);
    expect(exported.code).toBe(code);
    expect(
      verifyBundle(JSON.parse(readFileSync(join(f.paths.out, 'replayed.evidence.json'), 'utf8')))
        .verified,
    ).toBe(true);
  });
  it('rejects mismatched manifest without relabeling evidence', async () => {
    const f = setup();
    const changed: Manifest = structuredClone(f.manifest.value);
    changed.metadata.operator = 'Different operator';
    writeFileSync(f.paths.manifest, JSON.stringify(changed));
    const r = await f.invoke(['check', '--file', f.paths.file, '--offline']);
    expect(r.code).toBe(3);
    expect(r.result['faults']).toContain('configuration-digest-mismatch');
  });
  it('rejects a supplied pin that differs from the embedded pin', async () => {
    const f = setup();
    writeFileSync(
      f.paths.pins,
      JSON.stringify(f.pins.map((p) => ({ ...p, blockHash: hash(99n) }))),
    );
    expect(
      (await f.invoke(['check', '--file', f.paths.file, '--offline', '--pins', f.paths.pins])).code,
    ).toBe(3);
  });
  it('expires current health while preserving reproducible historical replay', async () => {
    const f = setup(),
      rt = { ...f.runtime, now: () => NOW + 900_000 };
    const r = await f.invoke(['check', '--file', f.paths.file], rt);
    expect(r.code).toBe(3);
    expect(r.result['currentStatus']).toBe('UNKNOWN');
    expect((await f.invoke(['check', '--file', f.paths.file, '--offline'], rt)).code).toBe(0);
  });
  it('bounds check work and resumes only the same evidence', async () => {
    const f = setup();
    const args = ['check', '--file', f.paths.file, '--offline', '--max-facts', '1'];
    expect((await f.invoke(args)).code).toBe(3);
    expect((await f.invoke([...args, '--resume'])).code).toBe(0);
    const checkpoint = JSON.parse(
      readFileSync(join(f.paths.out, 'replay-checkpoint.json'), 'utf8'),
    ) as Record<string, unknown>;
    checkpoint['cursor'] = 500;
    writeFileSync(join(f.paths.out, 'replay-checkpoint.json'), JSON.stringify(checkpoint));
    expect((await f.invoke([...args, '--resume'])).code).toBe(5);
  });
  it('rejects missing input and duplicated flags with stable machine errors', async () => {
    const f = setup();
    expect((await f.invoke(['check'])).code).toBe(5);
    expect((await f.invoke(['check', '--file', '/absent/ictt-input.json'])).code).toBe(5);
    expect((await f.invoke(['check', '--offline', '--offline'])).code).toBe(5);
  });
});

describe('doctor and registration RPC orchestration', () => {
  it('checks every readiness category against domain reads', async () => {
    const f = setup();
    const r = await f.invoke(['doctor', '--pins', f.paths.pins]);
    expect(r.code).toBe(0);
    expect(r.result).toMatchObject({ ready: true, database: true, telemetry: false });
  });
  it.each(['rpc', 'identity', 'fingerprint', 'finality', 'archive', 'database'] as const)(
    'fails closed on %s',
    async (fault) => {
      const f = setup();
      const rt: Runtime = {
        ...f.runtime,
        database: () => Promise.resolve(fault !== 'database'),
        read: async (ep, op, signal) => {
          if (
            fault === 'rpc' ||
            (fault === 'finality' && op.op === 'block-by-ref' && op.ref.kind === 'tag') ||
            (fault === 'archive' && op.op === 'logs')
          )
            throw new Error('untrusted-provider-detail');
          if (fault === 'identity' && op.op === 'evm-chain-id') return '0x1';
          if (fault === 'fingerprint' && op.op === 'code') return '0x6001';
          return f.runtime.read(ep, op, signal);
        },
      };
      const r = await f.invoke(['doctor', '--pins', f.paths.pins], rt);
      expect(r.code).toBe(3);
      expect(r.result['ready']).toBe(false);
      expect(r.stdout).not.toContain('untrusted-provider-detail');
    },
  );
  it('reports missing secret presence without disclosing values', async () => {
    const f = setup();
    delete f.env['DATABASE_URL'];
    expect((await f.invoke(['doctor', '--pins', f.paths.pins])).code).toBe(5);
  });
  it('collapses two declared trust domains that point at one host', async () => {
    const f = setup();
    const home = deployments(f.manifest.value)[0]!;
    const [first, second] = home.chain.endpoints;
    f.env[first!.secretRef] = 'https://rpc.shared.test/first';
    f.env[second!.secretRef] = 'https://rpc.shared.test/second';
    const r = await f.invoke(['doctor', '--pins', f.paths.pins]);
    expect(r.code).toBe(3);
    expect(r.result['ready']).toBe(false);
    const chains = r.result['chains'] as {
      independent: number;
      correlation: { resolved: boolean; findings: Record<string, unknown>[] };
    }[];
    expect(chains[0]?.independent).toBe(1);
    expect(chains[0]?.correlation.findings[0]).toMatchObject({
      signal: 'same-hostname',
      conclusive: true,
    });
    // The declared domains are named, the infrastructure never is. Pair order
    // follows the pseudonymous endpoint id, so compare it as a set.
    expect((chains[0]?.correlation.findings[0]?.['trustDomains'] as string[]).toSorted()).toEqual([
      'provider-alpha',
      'provider-beta',
    ]);
    expect(r.stdout).not.toContain('rpc.shared.test');
  });
  it('refuses a registration quorum whose endpoints point at one host', async () => {
    const f = setup();
    const home = deployments(f.manifest.value)[0]!;
    const [first, second] = home.chain.endpoints;
    f.env[first!.secretRef] = 'https://rpc.shared.test/first';
    f.env[second!.secretRef] = 'https://rpc.shared.test/second';
    const r = await f.invoke(['discover', '--pins', f.paths.pins]);
    expect(r.code).toBe(3);
    expect(r.result['missing']).toContain('endpoint-independence-collapsed');
    expect(r.stdout).not.toContain('rpc.shared.test');
  });
  it('counts shared upstream transitively', () => {
    expect(
      independentCount([
        { trustDomain: 'a', providerGroup: 'x' },
        { trustDomain: 'b', providerGroup: 'y' },
        { trustDomain: 'a', providerGroup: 'y' },
      ]),
    ).toBe(1);
  });
  it('writes an importable candidate and real diff, preserves approved baseline and resumes a bounded range', async () => {
    const f = setup();
    const original = readFileSync(f.paths.manifest, 'utf8');
    const args = ['discover', '--pins', f.paths.pins];
    const r = await f.invoke(args);
    expect(r.code).toBe(3);
    expect(r.result['complete']).toBe(false);
    const candidate = loadManifest(
      readFileSync(join(f.paths.out, 'candidate.manifest.json'), 'utf8'),
    );
    expect(candidate.value.spec.baseline.state).toBe('candidate');
    expect(candidate.value.spec.baseline).not.toHaveProperty('approval');
    expect((await f.invoke([...args, '--resume'])).result['complete']).toBe(true);
    expect(readFileSync(f.paths.manifest, 'utf8')).toBe(original);
    expect(r.result['diff']).toEqual({ added: [], missing: [], changed: [] });
  });
  it('does not advance discovery on differing provider logs', async () => {
    const f = setup();
    const rt: Runtime = {
      ...f.runtime,
      read: async (ep, op, signal) =>
        op.op === 'logs' && op.topics !== undefined && ep.role === 'secondary'
          ? []
          : f.runtime.read(ep, op, signal),
    };
    expect(
      (await f.invoke(['discover', '--pins', f.paths.pins], rt)).result['checkpointAdvanced'],
    ).toBe(false);
    expect(existsSync(join(f.paths.out, 'discovery-checkpoint.json'))).toBe(false);
  });
  it('cancels pending RPC and writes no checkpoint', async () => {
    const f = setup(),
      controller = new AbortController();
    const rt: Runtime = {
      ...f.runtime,
      read: async (_ep, _op, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('cancelled'));
            },
            { once: true },
          );
          controller.abort();
        }),
    };
    expect((await f.invoke(['discover', '--pins', f.paths.pins], rt, controller.signal)).code).toBe(
      6,
    );
    expect(existsSync(join(f.paths.out, 'discovery-checkpoint.json'))).toBe(false);
  });
});

describe('bounded production HTTP boundary', () => {
  it('sends only allowlisted query requests and returns decoded result', async () => {
    const f = setup();
    const ep = f.manifest.value.spec.home.chain.endpoints[0]!;
    const rt = createRuntime(
      { [ep.secretRef]: 'https://rpc.example.invalid/path' },
      f.policy.value,
      (_url, init) => {
        // `init.body` is a BodyInit; this transport always sends a JSON string,
        // so read it as one rather than stringifying an object into "[object Object]".
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
          string,
          unknown
        >;
        expect(body['method']).toBe('eth_chainId');
        expect(init?.redirect).toBe('error');
        return Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xa86a' })),
        );
      },
    );
    expect(await rt.read(ep, { op: 'evm-chain-id' }, new AbortController().signal)).toBe('0xa86a');
  });
  it('aborts a stalled HTTP request at the configured timeout', async () => {
    const f = setup();
    const ep = f.manifest.value.spec.home.chain.endpoints[0]!;
    const rt = createRuntime(
      { [ep.secretRef]: 'https://rpc.example.invalid/path' },
      f.policy.value,
      async (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('secret-provider-detail'));
            },
            { once: true },
          );
        }),
    );
    await expect(rt.read(ep, { op: 'evm-chain-id' }, new AbortController().signal)).rejects.toThrow(
      'RPC unavailable or timed out.',
    );
  });
  it('refuses insecure endpoints before any fetch', async () => {
    const f = setup();
    const ep = f.manifest.value.spec.home.chain.endpoints[0]!;
    let called = false;
    const rt = createRuntime({ [ep.secretRef]: 'http://127.0.0.1/' }, f.policy.value, () => {
      called = true;
      throw new Error();
    });
    await expect(rt.read(ep, { op: 'evm-chain-id' }, new AbortController().signal)).rejects.toThrow(
      'Endpoint unavailable.',
    );
    expect(called).toBe(false);
  });
});
