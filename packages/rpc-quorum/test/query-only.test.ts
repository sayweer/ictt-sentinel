import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_METHODS,
  FORBIDDEN_METHODS,
  assertSendable,
  isAllowedMethod,
  isForbiddenMethod,
} from '../src/methods.js';
import {
  PRECOMPILES,
  assertLogRange,
  buildRequest,
  readAllowListCalldata,
  warpGetBlockchainIdCalldata,
} from '../src/operations.js';
import {
  DEFAULT_TRANSPORT_POLICY,
  checkEndpointUrl,
  jsonDepth,
  sendChecked,
} from '../src/transport.js';
import { RpcError } from '../src/errors.js';
import { FakeTransport, endpoint, noSleep } from './fake-transport.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

const sourceFiles = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (e.endsWith('.ts')) out.push(full);
  }
  return out;
};

describe('the package exposes no write or signing surface', () => {
  const files = sourceFiles(SRC);

  it('reads its own sources', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each([
    [
      'wallet or account imports',
      /from\s+['"](?:viem\/accounts|ethers\/wallet|@ethersproject\/wallet)['"]/,
    ],
    ['private key handling', /\bprivateKey\b/],
    ['wallet client construction', /createWalletClient|new\s+Wallet\b/],
    ['transaction signing', /signTransaction|signTypedData|\bsendTransaction\b/],
  ])('contains no %s', (_label, pattern) => {
    for (const f of files) {
      // The forbidden-method list names these strings in order to ban them.
      if (f.endsWith('methods.ts')) continue;
      expect(readFileSync(f, 'utf8'), f).not.toMatch(pattern);
    }
  });

  it('never sends a forbidden method', () => {
    for (const m of FORBIDDEN_METHODS) {
      expect(isForbiddenMethod(m), m).toBe(true);
      expect(isAllowedMethod(m), m).toBe(false);
      expect(() => assertSendable(m)).toThrow(/never writes to a chain/);
    }
  });

  it.each([
    'eth_sendRawTransaction',
    'eth_sendTransaction',
    'personal_sign',
    'wallet_addEthereumChain',
    'admin_addPeer',
    'engine_forkchoiceUpdatedV1',
    'debug_traceCall',
    'miner_setEtherbase',
    'evm_mine',
    'hardhat_setBalance',
  ])('refuses %s', (method) => {
    expect(() => assertSendable(method)).toThrow();
  });

  it('refuses an unknown method even when it looks harmless', () => {
    expect(() => assertSendable('eth_getProof')).toThrow(/not on the read-only allowlist/);
    expect(() => assertSendable('avax_getUTXOs')).toThrow(/not on the read-only allowlist/);
  });

  it('allows exactly the documented read methods and nothing else', () => {
    expect([...ALLOWED_METHODS].every(isAllowedMethod)).toBe(true);
    expect(ALLOWED_METHODS.some((m) => isForbiddenMethod(m))).toBe(false);
    for (const m of ALLOWED_METHODS)
      expect(m.startsWith('eth_') || m.startsWith('net_')).toBe(true);
  });

  it('has no generic request(method, params) escape hatch', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/export\s+(?:const|function)\s+request\b/);
      expect(text, f).not.toMatch(/rawRequest|sendRaw\b|callAny\b/);
    }
  });
});

describe('operations map to allowed methods only', () => {
  it.each([
    [{ op: 'evm-chain-id' } as const, 'eth_chainId'],
    [{ op: 'network-version' } as const, 'net_version'],
    [{ op: 'head-block-number' } as const, 'eth_blockNumber'],
    [
      { op: 'block-by-ref', ref: { kind: 'tag', tag: 'latest' }, fullTransactions: false } as const,
      'eth_getBlockByNumber',
    ],
    [
      { op: 'block-by-ref', ref: { kind: 'hash', hash: '0xab' }, fullTransactions: false } as const,
      'eth_getBlockByHash',
    ],
    [{ op: 'transaction-receipt', txHash: '0xab' } as const, 'eth_getTransactionReceipt'],
    [{ op: 'warp-blockchain-id', at: { kind: 'number', number: 5n } } as const, 'eth_call'],
  ])('builds %o as %s', (operation, method) => {
    const req = buildRequest(operation);
    expect(req.method).toBe(method);
    expect(() => assertSendable(req.method)).not.toThrow();
  });

  it('pins a block-by-number reference as hex', () => {
    const req = buildRequest({
      op: 'block-by-ref',
      ref: { kind: 'number', number: 255n },
      fullTransactions: false,
    });
    expect(req.params[0]).toBe('0xff');
    expect(req.params[1]).toBe(false);
  });

  it('always reads a comparative call at a pinned reference, never at a tag by default', () => {
    const req = buildRequest({
      op: 'call',
      to: `0x${'a'.repeat(40)}`,
      data: '0x00',
      at: { kind: 'hash', hash: `0x${'b'.repeat(64)}` },
    });
    expect(req.params[1]).toBe(`0x${'b'.repeat(64)}`);
  });
});

describe('source-locked precompile reads', () => {
  it('uses the addresses declared in the pinned ICTT contracts', () => {
    expect(PRECOMPILES.warpMessenger).toBe('0x0200000000000000000000000000000000000005');
    expect(PRECOMPILES.nativeMinter).toBe('0x0200000000000000000000000000000000000001');
  });

  it('computes the getBlockchainID selector rather than pasting a literal', () => {
    const data = warpGetBlockchainIdCalldata();
    expect(data).toMatch(/^0x[0-9a-f]{8}$/);
    // keccak256("getBlockchainID()")[0:4]
    expect(data).toBe('0x4213cf78');
  });

  it('encodes readAllowList(address) with a left-padded address', () => {
    const data = readAllowListCalldata(`0x${'12'.repeat(20)}`);
    expect(data.slice(0, 10)).toMatch(/^0x[0-9a-f]{8}$/);
    expect(data.slice(10)).toBe('12'.repeat(20).padStart(64, '0'));
  });

  it('rejects a malformed address rather than encoding nonsense', () => {
    expect(() => readAllowListCalldata('0x1234')).toThrow();
  });

  it('exposes no write function of either precompile', () => {
    const text = readFileSync(join(SRC, 'operations.ts'), 'utf8');
    for (const fn of [
      'sendWarpMessage',
      'mintNativeCoin',
      'setAdmin',
      'setEnabled',
      'setManager',
    ]) {
      // Named only in the comment explaining their deliberate absence.
      const uses = text.split('\n').filter((l) => l.includes(fn) && !l.trim().startsWith('*'));
      expect(uses, fn).toEqual([]);
    }
  });
});

describe('log range is bounded', () => {
  it('accepts a range within the limit', () => {
    expect(() => {
      assertLogRange(100n, 199n, 2000);
    }).not.toThrow();
  });

  it('refuses an oversized range instead of trimming it', () => {
    // Silently narrowing would return fewer events, and fewer events is
    // indistinguishable from no events having happened.
    expect(() => {
      assertLogRange(0n, 5000n, 2000);
    }).toThrow(/split the scan/);
  });

  it('refuses an inverted range', () => {
    expect(() => {
      assertLogRange(200n, 100n, 2000);
    }).toThrow(/ends before it starts/);
  });
});

describe('endpoint URLs are validated before use', () => {
  const policy = DEFAULT_TRANSPORT_POLICY;

  it('accepts a public https endpoint', () => {
    expect(checkEndpointUrl('https://rpc.example.org/ext/bc/C/rpc', policy).ok).toBe(true);
  });

  it.each([
    ['plaintext http', 'http://rpc.example.org'],
    ['embedded credentials', 'https://user:pass@rpc.example.org'],
    ['localhost', 'https://localhost:8545'],
    ['loopback', 'https://127.0.0.1:8545'],
    ['RFC1918', 'https://10.0.0.5'],
    ['RFC1918 172', 'https://172.16.3.4'],
    ['RFC1918 192', 'https://192.168.1.1'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['mdns', 'https://node.local'],
    ['ipv6 loopback', 'https://[::1]:8545'],
    ['not a url', 'definitely not a url'],
  ])('refuses %s', (_label, url) => {
    expect(checkEndpointUrl(url, policy).ok).toBe(false);
  });

  it('enforces a host allowlist when one is configured', () => {
    const strict = { ...policy, allowedHosts: ['rpc.example.org'] };
    expect(checkEndpointUrl('https://rpc.example.org/x', strict).ok).toBe(true);
    const other = checkEndpointUrl('https://attacker.example/x', strict);
    expect(other.ok).toBe(false);
    expect(other.fault).toBe('host-not-allowed');
  });

  it('never follows redirects', () => {
    expect(policy.followRedirects).toBe(false);
    expect(policy.requireHttps).toBe(true);
  });
});

describe('transport policy is enforced', () => {
  const ep = endpoint('home-primary', 'provider-alpha');

  it('returns a result on the happy path', async () => {
    const t = new FakeTransport({
      endpoint: ep,
      script: { eth_chainId: [{ kind: 'result', result: '0xa86a' }] },
    });
    const out = await sendChecked(
      t,
      buildRequest({ op: 'evm-chain-id' }),
      DEFAULT_TRANSPORT_POLICY,
      noSleep,
    );
    expect(out).toBe('0xa86a');
  });

  it('retries a transient failure up to the bound, then fails', async () => {
    const t = new FakeTransport({
      endpoint: ep,
      script: { eth_chainId: [{ kind: 'throw', message: 'socket hang up' }] },
    });
    const policy = { ...DEFAULT_TRANSPORT_POLICY, maxRetries: 2 };
    await expect(
      sendChecked(t, buildRequest({ op: 'evm-chain-id' }), policy, noSleep),
    ).rejects.toBeInstanceOf(RpcError);
    expect(t.calls).toHaveLength(3);
  });

  it('does not retry an unsupported method', async () => {
    const t = new FakeTransport({
      endpoint: ep,
      script: {
        eth_chainId: [{ kind: 'error', code: -32601, message: 'the method does not exist' }],
      },
    });
    await expect(
      sendChecked(t, buildRequest({ op: 'evm-chain-id' }), DEFAULT_TRANSPORT_POLICY, noSleep),
    ).rejects.toMatchObject({ detail: { fault: 'unsupported-method' } });
    expect(t.calls).toHaveLength(1);
  });

  it('classifies a rate limit as transient', async () => {
    const t = new FakeTransport({
      endpoint: ep,
      script: { eth_chainId: [{ kind: 'error', code: -32005, message: 'rate limit exceeded' }] },
    });
    const err = await sendChecked(
      t,
      buildRequest({ op: 'evm-chain-id' }),
      { ...DEFAULT_TRANSPORT_POLICY, maxRetries: 1 },
      noSleep,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).detail.fault).toBe('rate-limited');
    expect((err as RpcError).transient).toBe(true);
  });

  it('classifies pruned history as permanent for the endpoint', async () => {
    const t = new FakeTransport({
      endpoint: ep,
      script: {
        eth_getStorageAt: [
          { kind: 'error', code: -32000, message: 'missing trie node, state is pruned' },
        ],
      },
    });
    await expect(
      sendChecked(
        t,
        buildRequest({
          op: 'storage-slot',
          address: `0x${'a'.repeat(40)}`,
          slot: `0x${'0'.repeat(64)}`,
          at: { kind: 'number', number: 1n },
        }),
        DEFAULT_TRANSPORT_POLICY,
        noSleep,
      ),
    ).rejects.toMatchObject({ detail: { fault: 'pruned-history' } });
    expect(t.calls).toHaveLength(1);
  });

  it('aborts on timeout and reports it as such', async () => {
    const t = new FakeTransport({ endpoint: ep, script: { eth_chainId: [{ kind: 'timeout' }] } });
    const policy = { ...DEFAULT_TRANSPORT_POLICY, requestTimeoutMs: 10, maxRetries: 0 };
    await expect(
      sendChecked(t, buildRequest({ op: 'evm-chain-id' }), policy, noSleep),
    ).rejects.toMatchObject({
      detail: { fault: 'timeout' },
    });
  });

  it('refuses a response nested past the depth limit', async () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 80; i += 1) deep = { n: deep };
    const t = new FakeTransport({
      endpoint: ep,
      script: { eth_chainId: [{ kind: 'result', result: deep }] },
    });
    await expect(
      sendChecked(
        t,
        buildRequest({ op: 'evm-chain-id' }),
        { ...DEFAULT_TRANSPORT_POLICY, maxJsonDepth: 64 },
        noSleep,
      ),
    ).rejects.toMatchObject({ detail: { fault: 'response-too-deep' } });
  });

  it('measures nesting depth', () => {
    expect(jsonDepth('x')).toBe(0);
    expect(jsonDepth({ a: { b: 1 } })).toBe(2);
    expect(jsonDepth([[[1]]])).toBe(3);
  });

  it('reports the endpoint id and never a URL', async () => {
    const t = new FakeTransport({
      endpoint: ep,
      script: { eth_chainId: [{ kind: 'throw', message: 'boom' }] },
    });
    const err = await sendChecked(
      t,
      buildRequest({ op: 'evm-chain-id' }),
      { ...DEFAULT_TRANSPORT_POLICY, maxRetries: 0 },
      noSleep,
    ).catch((e: unknown) => e);
    expect((err as Error).message).toContain('home-primary');
    expect((err as Error).message).not.toContain('http');
  });
});
