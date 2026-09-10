import { describe, expect, it } from 'vitest';
import {
  CONCLUSIVE_SIGNALS,
  correlateEndpoints,
  type EndpointCorrelationInput,
} from '../src/independence.js';

const hash = (input: string): string => {
  let acc = 0;
  for (let i = 0; i < input.length; i++) acc = (acc * 31 + input.charCodeAt(i)) >>> 0;
  return `h${acc.toString(16).padStart(8, '0')}${String(input.length).padStart(8, '0')}`;
};

const endpoint = (
  id: string,
  trustDomain: string,
  over: Partial<EndpointCorrelationInput> = {},
): EndpointCorrelationInput => ({
  endpointId: id,
  trustDomain,
  secretRef: `RPC_${id.toUpperCase()}`,
  hostname: `${id}.example.test`,
  addresses: [],
  cnames: [],
  ...over,
});

describe('declared independence is compared against observed infrastructure', () => {
  it('collapses two declared domains that share one secret reference', () => {
    const r = correlateEndpoints(
      [
        endpoint('a', 'domain-one', { secretRef: 'RPC_SHARED' }),
        endpoint('b', 'domain-two', { secretRef: 'RPC_SHARED' }),
      ],
      hash,
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      signal: 'same-secret-ref',
      conclusive: true,
      endpointIds: ['a', 'b'],
      trustDomains: ['domain-one', 'domain-two'],
    });
    expect(r.merges).toEqual([['a', 'b']]);
  });

  it('collapses two declared domains that resolve to one hostname', () => {
    const r = correlateEndpoints(
      [
        endpoint('a', 'domain-one', { hostname: 'rpc.vendor.test' }),
        endpoint('b', 'domain-two', { hostname: 'rpc.vendor.test' }),
      ],
      hash,
    );
    expect(r.findings[0]).toMatchObject({ signal: 'same-hostname', conclusive: true });
    expect(r.merges).toEqual([['a', 'b']]);
  });

  it('reports a shared address without collapsing the count', () => {
    const r = correlateEndpoints(
      [
        endpoint('a', 'domain-one', { addresses: ['198.51.100.7', '198.51.100.8'] }),
        endpoint('b', 'domain-two', { addresses: ['203.0.113.1', '198.51.100.7'] }),
      ],
      hash,
    );
    expect(r.findings[0]).toMatchObject({ signal: 'shared-address', conclusive: false });
    expect(r.merges).toEqual([]);
  });

  it('reports a shared CNAME target without collapsing the count', () => {
    const r = correlateEndpoints(
      [
        endpoint('a', 'domain-one', { cnames: ['edge.upstream.test'] }),
        endpoint('b', 'domain-two', { cnames: ['edge.upstream.test'] }),
      ],
      hash,
    );
    expect(r.findings[0]).toMatchObject({ signal: 'shared-cname', conclusive: false });
    expect(r.merges).toEqual([]);
  });

  it('reports only the strongest signal for one pair', () => {
    const shared = { hostname: 'rpc.vendor.test', addresses: ['198.51.100.7'] };
    const r = correlateEndpoints(
      [endpoint('a', 'domain-one', shared), endpoint('b', 'domain-two', shared)],
      hash,
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.signal).toBe('same-hostname');
  });

  it('ignores correlation inside one declared domain', () => {
    const r = correlateEndpoints(
      [
        endpoint('a', 'domain-one', { hostname: 'rpc.vendor.test' }),
        endpoint('b', 'domain-one', { hostname: 'rpc.vendor.test' }),
      ],
      hash,
    );
    expect(r.findings).toEqual([]);
    expect(r.merges).toEqual([]);
  });

  it('finds nothing when resolution was unavailable', () => {
    const r = correlateEndpoints(
      [
        endpoint('a', 'domain-one', { hostname: null }),
        endpoint('b', 'domain-two', { hostname: null }),
      ],
      hash,
    );
    expect(r.findings).toEqual([]);
  });

  it('never emits the shared value itself', () => {
    const r = correlateEndpoints(
      [
        endpoint('a', 'domain-one', { hostname: 'secret-tenant.vendor.test' }),
        endpoint('b', 'domain-two', { hostname: 'secret-tenant.vendor.test' }),
      ],
      hash,
    );
    expect(JSON.stringify(r)).not.toContain('secret-tenant');
    expect(r.findings[0]?.sharedDigest).toHaveLength(16);
  });

  it('is stable regardless of input order', () => {
    const a = endpoint('a', 'domain-one', { addresses: ['198.51.100.7'] });
    const b = endpoint('b', 'domain-two', { addresses: ['198.51.100.7'] });
    expect(correlateEndpoints([a, b], hash)).toEqual(correlateEndpoints([b, a], hash));
  });

  it('treats exactly the no-network signals as conclusive', () => {
    expect([...CONCLUSIVE_SIGNALS]).toEqual(['same-secret-ref', 'same-hostname']);
  });
});
