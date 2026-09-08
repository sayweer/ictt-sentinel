import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBundle, type EvidenceBundle } from '@ictt-sentinel/evidence';
import { project } from '@ictt-sentinel/alerts';
import { quickstartBundleDraft } from '@ictt-sentinel/testkit';
import { API_VERSION, buildApi, tokenHash } from '../src/server.js';
import type { ApiGrant, ApiIdentity, ApiStore, HostedRecord, HostedWrite } from '../src/store.js';

const NOW = new Date('2026-06-01T00:01:00.000Z');
const TOKEN_A = 'tenant-a-test-token-00000001';
const TOKEN_B = 'tenant-b-test-token-00000002';
const bundle = (): EvidenceBundle => buildBundle(quickstartBundleDraft('healthy'));

class MemoryStore implements ApiStore {
  isReady = true;
  readonly identities = new Map([
    [
      tokenHash(TOKEN_A),
      {
        tokenId: 'token-a',
        tenantId: 'tenant-a',
        scopes: ['status:read', 'evidence:read', 'ingest:write', 'alerts:ack'],
      },
    ],
    [
      tokenHash(TOKEN_B),
      {
        tokenId: 'token-b',
        tenantId: 'tenant-b',
        scopes: ['status:read', 'evidence:read', 'ingest:write', 'alerts:ack'],
      },
    ],
  ] satisfies [string, ApiIdentity][]);
  readonly deploymentGrants: ApiGrant[] = [
    { tenantId: 'tenant-a', deploymentId: 'quickstart-healthy', sharingLevel: 'approved-full' },
  ];
  readonly records: (HostedRecord & { tenantId: string; payloadHash: string })[] = [];
  readonly idempotency = new Map<
    string,
    { payloadHash: string; response: { status: number; body: unknown } }
  >();
  readonly nonces = new Set<string>();
  readonly hints: { tenantId: string; deploymentId: string }[] = [];
  readonly audits: { action: string; statusCode: number }[] = [];
  acknowledgements = 0;
  ready = () => Promise.resolve(this.isReady);
  authenticate = (hash: string) => Promise.resolve(this.identities.get(hash) ?? null);
  grant = (tenantId: string, deploymentId: string) =>
    Promise.resolve(
      this.deploymentGrants.find(
        (g) => g.tenantId === tenantId && g.deploymentId === deploymentId,
      ) ?? null,
    );
  grants = (tenantId: string, limit: number, after: string | null) =>
    Promise.resolve(
      this.deploymentGrants
        .filter((g) => g.tenantId === tenantId && (after === null || g.deploymentId > after))
        .slice(0, limit),
    );
  timeline = (tenantId: string, deploymentId: string, limit: number, after: string | null) =>
    Promise.resolve(
      this.records
        .filter((r) => r.tenantId === tenantId && r.deploymentId === deploymentId)
        .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
        .filter(
          (r, i, all) => after === null || i > all.findIndex((v) => v.evidenceDigest === after),
        )
        .slice(0, limit),
    );
  evidence = (tenantId: string, deploymentId: string, digest: string) =>
    Promise.resolve(
      this.records.find(
        (r) =>
          r.tenantId === tenantId && r.deploymentId === deploymentId && r.evidenceDigest === digest,
      ) ?? null,
    );
  ingest = (input: HostedWrite, key: string): Promise<{ status: number; body: unknown }> => {
    const id = `${input.tenantId}/${key}`,
      prior = this.idempotency.get(id);
    if (prior !== undefined) {
      if (prior.payloadHash !== input.payloadHash) throw new Error('conflict');
      return Promise.resolve({ status: 200, body: { accepted: true, duplicate: true } });
    }
    const same = this.records.find(
      (r) =>
        r.tenantId === input.tenantId &&
        r.deploymentId === input.deploymentId &&
        r.evidenceDigest === input.evidenceDigest,
    );
    if (same !== undefined && same.payloadHash !== input.payloadHash) throw new Error('conflict');
    if (same === undefined) this.records.push({ ...input, receivedAt: NOW });
    const response = {
      status: same === undefined ? 201 : 200,
      body: { accepted: true, duplicate: same !== undefined },
    };
    this.idempotency.set(id, { payloadHash: input.payloadHash, response });
    return Promise.resolve(response);
  };
  acknowledge = (tenantId: string) =>
    Promise.resolve(tenantId === 'tenant-a' ? ++this.acknowledgements : 0);
  claimNonce = (tenantId: string, nonce: string) => {
    const key = `${tenantId}/${nonce}`;
    if (this.nonces.has(key)) return Promise.resolve(false);
    this.nonces.add(key);
    return Promise.resolve(tenantId === 'tenant-a');
  };
  enqueueHint = async (tenantId: string, input: { deploymentId: string }) => {
    if ((await this.grant(tenantId, input.deploymentId)) === null) return false;
    this.hints.push({ tenantId, deploymentId: input.deploymentId });
    return true;
  };
  audit = (input: { action: string; statusCode: number }) => {
    this.audits.push(input);
    return Promise.resolve();
  };
}

const liveApps: ReturnType<typeof buildApi>[] = [];
afterEach(async () => {
  await Promise.all(liveApps.splice(0).map((app) => app.close()));
});
const fixture = (options: { rateLimit?: number; bodyLimit?: number } = {}) => {
  const store = new MemoryStore();
  const app = buildApi({
    store,
    now: () => NOW,
    webhookSecret: (tenant, source) =>
      tenant === 'tenant-a' && source === 'source-a' ? 'webhook-test-secret' : undefined,
    ...options,
  });
  liveApps.push(app);
  const headers = { authorization: `Bearer ${TOKEN_A}` };
  return { app, store, headers };
};
const ingest = (
  app: ReturnType<typeof buildApi>,
  body: unknown,
  key = 'idem-key-0000000001',
  token = TOKEN_A,
) =>
  app.inject({
    method: 'POST',
    url: '/v1/ingest/evaluations',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    payload: body,
  });

const jsonObject = (response: { json(): unknown }): Record<string, unknown> => {
  const value = response.json();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected a JSON object');
  }
  return value as Record<string, unknown>;
};

describe('hosted evidence API', () => {
  it('has separate public liveness and truth-path readiness', async () => {
    const { app, store } = fixture();
    expect((await app.inject('/live')).json()).toEqual({ schemaVersion: API_VERSION, live: true });
    store.isReady = false;
    expect((await app.inject('/ready')).statusCode).toBe(503);
  });
  it('publishes a versioned OpenAPI route inventory', async () => {
    const { app } = fixture();
    expect((await app.inject('/openapi.json')).json()).toMatchObject({
      openapi: '3.1.0',
      paths: { '/v1/ingest/evaluations': { post: expect.any(Object) } },
    });
  });
  it('ingests and independently verifies approved full evidence idempotently', async () => {
    const { app, headers, store } = fixture();
    const evidence = bundle();
    expect((await ingest(app, { level: 'approved-full', body: evidence })).statusCode).toBe(201);
    expect((await ingest(app, { level: 'approved-full', body: evidence })).statusCode).toBe(200);
    const status = await app.inject({ url: '/v1/deployments/quickstart-healthy/status', headers });
    expect(jsonObject(status)['status']).toMatchObject({
      verifyStatus: 'verified',
      currentProtocolStatus: 'OK',
    });
    const downloaded = await app.inject({
      url: `/v1/deployments/quickstart-healthy/evidence/${evidence.contentHash}`,
      headers,
    });
    expect(jsonObject(downloaded)['bundle']).toMatchObject({ contentHash: evidence.contentHash });
    expect(store.records).toHaveLength(1);
  });
  it('rejects one idempotency key reused for another payload', async () => {
    const { app } = fixture();
    const shared = project('sanitized-metadata', bundle());
    expect((await ingest(app, shared, 'same-key-000000001')).statusCode).toBe(201);
    const changed = structuredClone(shared) as { body: { reasonCodes: string[] } };
    changed.body.reasonCodes = ['DIFFERENT_REASON'];
    expect((await ingest(app, changed, 'same-key-000000001')).statusCode).toBe(409);
  });
  it('orders out-of-order uploads by observation time and expires stale OK to UNKNOWN', async () => {
    const { app, headers } = fixture();
    const shared = project('sanitized-metadata', bundle());
    if (shared.body === null) throw new Error('metadata missing');
    const newer = {
      ...shared,
      body: {
        ...shared.body,
        evidenceHash: 'a'.repeat(64),
        observedAt: '2026-06-01T00:00:00.000Z',
        expiresAt: '2026-06-01T00:00:30.000Z',
      },
    };
    const older = {
      ...shared,
      body: {
        ...shared.body,
        evidenceHash: 'b'.repeat(64),
        observedAt: '2026-05-31T23:00:00.000Z',
        expiresAt: '2026-06-01T00:00:01.000Z',
      },
    };
    expect((await ingest(app, newer, 'newer-key-00000001')).statusCode).toBe(201);
    expect((await ingest(app, older, 'older-key-00000001')).statusCode).toBe(201);
    const status = await app.inject({ url: '/v1/deployments/quickstart-healthy/status', headers });
    expect(jsonObject(status)['status']).toMatchObject({
      evidenceDigest: 'a'.repeat(64),
      currentProtocolStatus: 'UNKNOWN',
      stale: true,
    });
  });
  it('keeps tenants indistinguishable from absent deployments', async () => {
    const { app } = fixture();
    const foreign = await app.inject({
      url: '/v1/deployments/quickstart-healthy/status',
      headers: { authorization: `Bearer ${TOKEN_B}` },
    });
    const absent = await app.inject({
      url: '/v1/deployments/absent/status',
      headers: { authorization: `Bearer ${TOKEN_B}` },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toBe(absent.body);
  });
  it('rejects missing and expired credentials without reflecting them', async () => {
    const { app } = fixture();
    const missing = await app.inject('/v1/deployments');
    const bad = await app.inject({
      url: '/v1/deployments',
      headers: { authorization: 'Bearer expired-secret-token-123' },
    });
    expect(missing.statusCode).toBe(401);
    expect(bad.statusCode).toBe(401);
    expect(bad.body).not.toContain('expired-secret-token-123');
  });
  it('enforces pagination, body and rate limits', async () => {
    const { app, headers } = fixture({ rateLimit: 1, bodyLimit: 256 });
    expect((await app.inject({ url: '/v1/deployments?limit=101', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: '/v1/deployments', headers })).statusCode).toBe(429);
    const large = await app.inject({
      method: 'POST',
      url: '/v1/ingest/evaluations',
      headers: { ...headers, 'idempotency-key': 'large-body-00000001' },
      payload: { data: 'x'.repeat(1000) },
    });
    expect(large.statusCode).toBe(413);
  });
  it('rejects traversal-like deployment identifiers and has no RPC proxy', async () => {
    const { app, headers } = fixture();
    expect((await app.inject({ url: '/v1/deployments/%2e%2e/status', headers })).statusCode).toBe(
      404,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/rpc',
          headers,
          payload: { method: 'eth_sendTransaction' },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('returns message timelines only from explicitly approved full evidence', async () => {
    const { app, headers } = fixture();
    await ingest(app, { level: 'approved-full', body: bundle() });
    const response = await app.inject({
      url: '/v1/deployments/quickstart-healthy/messages',
      headers,
    });
    expect(jsonObject(response)['messages']).toHaveLength(1);
  });
  it('records a tenant-scoped acknowledgement without changing evidence', async () => {
    const { app, headers, store } = fixture();
    const digest = 'c'.repeat(64);
    expect(
      (await app.inject({ method: 'POST', url: `/v1/alerts/${digest}/acknowledge`, headers }))
        .statusCode,
    ).toBe(200);
    expect(store.acknowledgements).toBe(1);
  });
});

describe('webhook hint boundary', () => {
  const send = (
    app: ReturnType<typeof buildApi>,
    raw: string,
    nonce = 'nonce-0001',
    signature?: string,
  ) => {
    const stamp = String(NOW.getTime());
    const sig =
      signature ??
      createHmac('sha256', 'webhook-test-secret')
        .update(stamp)
        .update('.')
        .update(nonce)
        .update('.')
        .update(raw)
        .digest('hex');
    return app.inject({
      method: 'POST',
      url: '/v1/webhooks/tenant-a/source-a/hints',
      headers: {
        'content-type': 'application/vnd.ictt-sentinel.hint+json',
        'x-ictt-timestamp': stamp,
        'x-ictt-nonce': nonce,
        'x-ictt-signature': sig,
      },
      payload: raw,
    });
  };
  const body = JSON.stringify({
    deploymentId: 'quickstart-healthy',
    chainKey: 'quickstart-healthy/home',
    suggestedBlockNumber: '100',
  });
  it('verifies the raw body and enqueues only a bounded priority hint', async () => {
    const { app, store } = fixture();
    const response = await send(app, body);
    expect(response.statusCode).toBe(202);
    expect(jsonObject(response)['effect']).toBe('bounded-priority-hint-only');
    expect(store.hints).toHaveLength(1);
    expect(store.records).toHaveLength(0);
  });
  it('rejects bad signatures, expired timestamps and nonce replay', async () => {
    const { app } = fixture();
    expect((await send(app, body, 'nonce-bad1', '0'.repeat(64))).statusCode).toBe(401);
    expect((await send(app, body, 'nonce-good')).statusCode).toBe(202);
    expect((await send(app, body, 'nonce-good')).statusCode).toBe(409);
  });
  it('rejects JSON content type because signature must cover the retained raw body', async () => {
    const { app } = fixture();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/tenant-a/source-a/hints',
      headers: { 'content-type': 'application/json' },
      payload: JSON.parse(body),
    });
    expect(response.statusCode).toBe(401);
  });
});
