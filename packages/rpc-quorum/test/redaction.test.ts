import { describe, expect, it } from 'vitest';
import { redact, redactToJson } from '@ictt-sentinel/config';
import { RpcError, RpcIntegrityConflict } from '../src/errors.js';
import { DEFAULT_TRANSPORT_POLICY, sendChecked } from '../src/transport.js';
import { buildRequest } from '../src/operations.js';
import { FakeTransport, endpoint, noSleep } from './fake-transport.js';

/**
 * An RPC URL is a credential: the project id or API key usually lives in its
 * path. The canary below must not survive anywhere an operator or an evidence
 * bundle could see it.
 */
const CANARY = 'canary-9f3c1a7e2b8d4056';
const RPC_URL = `https://rpc.example.org/v3/${CANARY}`;

describe('an endpoint address never reaches an error, log or metric', () => {
  const ep = endpoint('home-primary', 'provider-alpha');

  it('an RpcError names the endpoint id, not its URL', async () => {
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

    expect(err).toBeInstanceOf(RpcError);
    const e = err as RpcError;
    expect(e.message).toContain('home-primary');
    expect(e.message).not.toContain(CANARY);
    expect(e.detail.endpointId).toBe('home-primary');
    expect(JSON.stringify(e.detail)).not.toContain(CANARY);
  });

  it('a provider error carrying the URL is redacted before it is reported', async () => {
    // Some providers echo the request URL back inside the error message.
    const t = new FakeTransport({
      endpoint: ep,
      script: {
        eth_chainId: [{ kind: 'error', code: -32000, message: `upstream failure at ${RPC_URL}` }],
      },
    });
    const err = await sendChecked(
      t,
      buildRequest({ op: 'evm-chain-id' }),
      { ...DEFAULT_TRANSPORT_POLICY, maxRetries: 0 },
      noSleep,
    ).catch((e: unknown) => e);

    expect(redactToJson(err)).not.toContain(CANARY);
  });

  it('walks a nested cause chain from a transport failure', () => {
    const inner = new Error(`connect ECONNREFUSED for ${RPC_URL}`);
    const outer = new RpcError({
      fault: 'transport',
      endpointId: 'home-primary',
      trustDomain: 'provider-alpha',
      message: 'endpoint unreachable',
    });
    (outer as { cause?: unknown }).cause = inner;
    expect(redactToJson(outer)).not.toContain(CANARY);
  });

  it('redacts an integrity conflict payload', () => {
    const conflict = new RpcIntegrityConflict({
      blockNumber: 1000n,
      recordedHash: `0x${'a'.repeat(64)}`,
      observedHash: `0x${'b'.repeat(64)}`,
      endpointId: 'home-secondary',
      trustDomain: 'provider-beta',
    });
    (conflict as { cause?: unknown }).cause = new Error(`served by ${RPC_URL}`);
    const out = redactToJson(conflict);
    expect(out).not.toContain(CANARY);
    // The parts that make the incident actionable survive.
    expect(out).toContain('home-secondary');
    expect(out).toContain('1000');
  });

  it('keeps block hashes intact while removing the URL', () => {
    const hash = `0x${'c'.repeat(64)}`;
    const out = redactToJson({ note: `mismatch at ${RPC_URL}`, blockHash: hash });
    expect(out).not.toContain(CANARY);
    expect(out).toContain(hash);
  });

  it('redacts a URL that appears under a metrics-shaped label', () => {
    // Metrics carry endpoint ids and provider groups, never addresses.
    const sample = { endpointId: 'home-primary', providerGroup: 'alpha-prod', url: RPC_URL };
    const out = redact(sample) as Record<string, unknown>;
    expect(out['url']).toBe('[REDACTED]');
    expect(out['endpointId']).toBe('home-primary');
  });
});
