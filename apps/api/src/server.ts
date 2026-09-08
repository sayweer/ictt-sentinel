import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { CLAIM_MODES, COVERAGE_STATES } from '@ictt-sentinel/invariant-core';
import {
  canonicalStringify,
  domainSeparatedSha256,
  verifyBundle,
  type EvidenceBundle,
} from '@ictt-sentinel/evidence';
import type { ApiIdentity, ApiStore, HostedRecord, HostedWrite } from './store.js';
import { fullBundle } from './store.js';

export const API_VERSION = 'ictt-sentinel/hosted-api/v1' as const;
const ID = /^[a-z0-9][a-z0-9._/-]{0,126}$/;
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,126}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const IDEMPOTENCY = /^[A-Za-z0-9_.:-]{16,128}$/;
const NONCE = /^[A-Za-z0-9_.:-]{8,128}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;
const STATUSES = ['OK', 'WARN', 'UNKNOWN', 'CRITICAL'] as const;
const DATA = ['COMPLETE', 'STALE', 'PARTIAL', 'DIVERGENT', 'UNKNOWN'] as const;
const HINT_MEDIA = 'application/vnd.ictt-sentinel.hint+json';

export const tokenHash = (token: string): string =>
  createHash('sha256').update('ictt-sentinel/api-token/v1\n').update(token).digest('hex');

class RateLimiter {
  readonly #entries = new Map<string, { start: number; count: number }>();
  readonly #limit: number;
  readonly #windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }
  take(key: string, now: number): boolean {
    const current = this.#entries.get(key);
    if (current === undefined || now - current.start >= this.#windowMs) {
      this.#entries.set(key, { start: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.#limit;
  }
}

export interface ApiOptions {
  readonly store: ApiStore;
  readonly now?: () => Date;
  readonly auditId?: (requestId: string, action: string) => string;
  readonly rateLimit?: number;
  readonly bodyLimit?: number;
  readonly webhookSecret?: (tenantId: string, sourceId: string) => string | undefined;
}
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const iso = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const member = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);
const publicRecord = (r: HostedRecord) => ({
  deploymentId: r.deploymentId,
  evidenceDigest: r.evidenceDigest,
  sharingLevel: r.sharingLevel,
  verifyStatus: r.verifyStatus,
  protocolStatus: r.protocolStatus,
  dataStatus: r.dataStatus,
  observedAt: r.observedAt.toISOString(),
  expiresAt: r.expiresAt.toISOString(),
  receivedAt: r.receivedAt.toISOString(),
});

const OPENAPI = {
  openapi: '3.1.0',
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: { title: 'ictt-sentinel hosted evidence API', version: '1.0.0' },
  components: {
    securitySchemes: {
      bearerToken: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' },
      webhookSignature: { type: 'apiKey', in: 'header', name: 'x-ictt-signature' },
    },
  },
  paths: {
    '/live': {
      get: { operationId: 'live', responses: { '200': { description: 'Process live' } } },
    },
    '/ready': {
      get: {
        operationId: 'ready',
        responses: {
          '200': { description: 'Truth path ready' },
          '503': { description: 'Truth path unavailable' },
        },
      },
    },
    '/v1/deployments': {
      get: {
        operationId: 'listDeployments',
        security: [{ bearerToken: [] }],
        responses: { '200': { description: 'Authorized deployments' } },
      },
    },
    '/v1/deployments/{deploymentId}/status': {
      get: {
        operationId: 'deploymentStatus',
        security: [{ bearerToken: [] }],
        responses: { '200': { description: 'Latest verdict' } },
      },
    },
    '/v1/deployments/{deploymentId}/verdicts': {
      get: {
        operationId: 'verdictTimeline',
        security: [{ bearerToken: [] }],
        responses: { '200': { description: 'Verdict timeline' } },
      },
    },
    '/v1/deployments/{deploymentId}/messages': {
      get: {
        operationId: 'messageTimeline',
        security: [{ bearerToken: [] }],
        responses: { '200': { description: 'Approved message timeline' } },
      },
    },
    '/v1/deployments/{deploymentId}/evidence': {
      get: {
        operationId: 'evidenceMetadata',
        security: [{ bearerToken: [] }],
        responses: { '200': { description: 'Evidence metadata' } },
      },
    },
    '/v1/deployments/{deploymentId}/evidence/{digest}': {
      get: {
        operationId: 'downloadEvidence',
        security: [{ bearerToken: [] }],
        responses: { '200': { description: 'Evidence record and approved bundle' } },
      },
    },
    '/v1/ingest/evaluations': {
      post: {
        operationId: 'ingestEvaluation',
        security: [{ bearerToken: [] }],
        responses: {
          '200': { description: 'Idempotent replay' },
          '201': { description: 'Accepted' },
          '409': { description: 'Idempotency conflict' },
        },
      },
    },
    '/v1/alerts/{incidentKey}/acknowledge': {
      post: {
        operationId: 'acknowledgeAlert',
        security: [{ bearerToken: [] }],
        responses: { '200': { description: 'Acknowledged' } },
      },
    },
    '/v1/webhooks/{tenantId}/{sourceId}/hints': {
      post: {
        operationId: 'receiveHint',
        security: [{ webhookSignature: [] }],
        responses: { '202': { description: 'Bounded hint accepted' } },
      },
    },
  },
} as const;

export const buildApi = (options: ApiOptions): FastifyInstance => {
  const now = options.now ?? (() => new Date());
  const rate = new RateLimiter(options.rateLimit ?? 120, 60_000);
  const app = Fastify({
    logger: false,
    bodyLimit: options.bodyLimit ?? 4 * 1024 * 1024,
    requestTimeout: 10_000,
    connectionTimeout: 10_000,
    maxRequestsPerSocket: 100,
  });
  app.addContentTypeParser(HINT_MEDIA, { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = object(error)?.['statusCode'];
    const status = statusCode === 413 || statusCode === 415 ? statusCode : 400;
    void reply.code(status).send({
      schemaVersion: API_VERSION,
      error:
        status === 413
          ? 'body-too-large'
          : status === 415
            ? 'unsupported-content-type'
            : 'invalid-request',
    });
  });

  const audit = async (
    request: FastifyRequest,
    identity: ApiIdentity | null,
    action: string,
    outcome: 'allowed' | 'denied' | 'error',
    statusCode: number,
  ): Promise<void> => {
    const id =
      options.auditId?.(request.id, action) ??
      domainSeparatedSha256('ictt-sentinel/api-audit/v1', `${request.id}/${action}`);
    await options.store.audit({
      auditId: id,
      tenantId: identity?.tenantId ?? null,
      tokenId: identity?.tokenId ?? null,
      requestId: request.id,
      action,
      resource: request.routeOptions.url ?? 'unknown',
      outcome,
      statusCode,
      detail: { method: request.method },
    });
  };
  const authorize = async (
    request: FastifyRequest,
    reply: FastifyReply,
    scope: string,
  ): Promise<ApiIdentity | null> => {
    const auth = request.headers.authorization;
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const hash = tokenHash(token);
    if (!rate.take(`auth/${hash}`, now().getTime())) {
      await audit(request, null, scope, 'denied', 429);
      await reply.code(429).send({ schemaVersion: API_VERSION, error: 'rate-limited' });
      return null;
    }
    const identity = token.length >= 16 ? await options.store.authenticate(hash, now()) : null;
    if (identity === null) {
      await audit(request, null, scope, 'denied', 401);
      await reply.code(401).send({ schemaVersion: API_VERSION, error: 'unauthorized' });
      return null;
    }
    if (!identity.scopes.includes(scope)) {
      await audit(request, identity, scope, 'denied', 403);
      await reply.code(403).send({ schemaVersion: API_VERSION, error: 'forbidden' });
      return null;
    }
    return identity;
  };
  const deployment = async (request: FastifyRequest, reply: FastifyReply, scope: string) => {
    const identity = await authorize(request, reply, scope);
    if (identity === null) return null;
    const params = object(request.params);
    const id = params?.['deploymentId'];
    if (typeof id !== 'string' || !ID.test(id) || id.includes('..')) {
      await audit(request, identity, scope, 'denied', 404);
      await reply.code(404).send({ schemaVersion: API_VERSION, error: 'not-found' });
      return null;
    }
    const grant = await options.store.grant(identity.tenantId, id);
    if (grant === null) {
      await audit(request, identity, scope, 'denied', 404);
      await reply.code(404).send({ schemaVersion: API_VERSION, error: 'not-found' });
      return null;
    }
    return { identity, grant };
  };
  const page = (
    request: FastifyRequest,
    validCursor: (cursor: string) => boolean = (cursor) => DIGEST.test(cursor),
  ): { limit: number; after: string | null } | null => {
    const q = object(request.query) ?? {};
    if (Object.keys(q).some((key) => key !== 'limit' && key !== 'after')) return null;
    const raw = q['limit'] ?? '50',
      after = q['after'] ?? null;
    if (
      typeof raw !== 'string' ||
      !/^[1-9][0-9]?$|^100$/.test(raw) ||
      (after !== null && (typeof after !== 'string' || !validCursor(after)))
    )
      return null;
    return { limit: Number(raw), after };
  };

  app.get('/openapi.json', () => OPENAPI);
  app.get('/live', () => ({ schemaVersion: API_VERSION, live: true }));
  app.get('/ready', async (_request, reply) => {
    const ready = await options.store.ready();
    return reply.code(ready ? 200 : 503).send({ schemaVersion: API_VERSION, ready });
  });
  app.get('/v1/deployments', async (request, reply) => {
    const identity = await authorize(request, reply, 'status:read');
    if (identity === null) return;
    const p = page(request, (cursor) => ID.test(cursor) && !cursor.includes('..'));
    if (p === null)
      return reply.code(400).send({ schemaVersion: API_VERSION, error: 'invalid-pagination' });
    const grants = await options.store.grants(identity.tenantId, p.limit, p.after);
    await audit(request, identity, 'status:read', 'allowed', 200);
    return {
      schemaVersion: API_VERSION,
      deployments: grants,
      next: grants.length === p.limit ? (grants.at(-1)?.deploymentId ?? null) : null,
    };
  });
  app.get('/v1/deployments/:deploymentId/status', async (request, reply) => {
    const auth = await deployment(request, reply, 'status:read');
    if (auth === null) return;
    const rows = await options.store.timeline(
      auth.identity.tenantId,
      auth.grant.deploymentId,
      1,
      null,
    );
    const current = rows[0] ?? null;
    const expired = current !== null && now().getTime() >= current.expiresAt.getTime();
    await audit(request, auth.identity, 'status:read', 'allowed', 200);
    return {
      schemaVersion: API_VERSION,
      deploymentId: auth.grant.deploymentId,
      status:
        current === null
          ? null
          : {
              ...publicRecord(current),
              stale: expired,
              currentProtocolStatus:
                expired && current.protocolStatus !== 'CRITICAL'
                  ? 'UNKNOWN'
                  : current.protocolStatus,
              currentDataStatus: expired ? 'STALE' : current.dataStatus,
            },
    };
  });
  app.get('/v1/deployments/:deploymentId/verdicts', async (request, reply) => {
    const auth = await deployment(request, reply, 'status:read');
    if (auth === null) return;
    const p = page(request);
    if (p === null)
      return reply.code(400).send({ schemaVersion: API_VERSION, error: 'invalid-pagination' });
    const rows = await options.store.timeline(
      auth.identity.tenantId,
      auth.grant.deploymentId,
      p.limit,
      p.after,
    );
    await audit(request, auth.identity, 'status:read', 'allowed', 200);
    return {
      schemaVersion: API_VERSION,
      items: rows.map(publicRecord),
      next: rows.length === p.limit ? (rows.at(-1)?.evidenceDigest ?? null) : null,
    };
  });
  app.get('/v1/deployments/:deploymentId/messages', async (request, reply) => {
    const auth = await deployment(request, reply, 'evidence:read');
    if (auth === null) return;
    const rows = await options.store.timeline(
      auth.identity.tenantId,
      auth.grant.deploymentId,
      100,
      null,
    );
    const messages = rows.flatMap(
      (r) =>
        fullBundle(r)?.core.messages.map((m) => ({ evidenceDigest: r.evidenceDigest, ...m })) ?? [],
    );
    await audit(request, auth.identity, 'evidence:read', 'allowed', 200);
    return { schemaVersion: API_VERSION, messages: messages.slice(0, 100) };
  });
  app.get('/v1/deployments/:deploymentId/evidence', async (request, reply) => {
    const auth = await deployment(request, reply, 'evidence:read');
    if (auth === null) return;
    const p = page(request);
    if (p === null)
      return reply.code(400).send({ schemaVersion: API_VERSION, error: 'invalid-pagination' });
    const rows = await options.store.timeline(
      auth.identity.tenantId,
      auth.grant.deploymentId,
      p.limit,
      p.after,
    );
    await audit(request, auth.identity, 'evidence:read', 'allowed', 200);
    return {
      schemaVersion: API_VERSION,
      evidence: rows.map(publicRecord),
      next: rows.length === p.limit ? (rows.at(-1)?.evidenceDigest ?? null) : null,
    };
  });
  app.get('/v1/deployments/:deploymentId/evidence/:digest', async (request, reply) => {
    const auth = await deployment(request, reply, 'evidence:read');
    if (auth === null) return;
    const digest = object(request.params)?.['digest'];
    if (typeof digest !== 'string' || !DIGEST.test(digest))
      return reply.code(404).send({ schemaVersion: API_VERSION, error: 'not-found' });
    const record = await options.store.evidence(
      auth.identity.tenantId,
      auth.grant.deploymentId,
      digest,
    );
    if (record === null)
      return reply.code(404).send({ schemaVersion: API_VERSION, error: 'not-found' });
    const bundle = fullBundle(record);
    await audit(request, auth.identity, 'evidence:read', 'allowed', 200);
    return { schemaVersion: API_VERSION, metadata: publicRecord(record), bundle };
  });

  app.post('/v1/ingest/evaluations', async (request, reply) => {
    const identity = await authorize(request, reply, 'ingest:write');
    if (identity === null) return;
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !IDEMPOTENCY.test(key))
      return reply.code(400).send({ schemaVersion: API_VERSION, error: 'invalid-idempotency-key' });
    const body = object(request.body);
    if (
      body === null ||
      !exact(body, ['level', 'body']) ||
      (body['level'] !== 'sanitized-metadata' && body['level'] !== 'approved-full')
    )
      return reply.code(400).send({ schemaVersion: API_VERSION, error: 'invalid-ingest' });
    let input: HostedWrite;
    if (body['level'] === 'approved-full') {
      const check = verifyBundle(body['body']);
      if (!check.verified)
        return reply.code(400).send({ schemaVersion: API_VERSION, error: 'evidence-not-verified' });
      const bundle = body['body'] as EvidenceBundle;
      input = {
        tenantId: identity.tenantId,
        deploymentId: bundle.core.deploymentId,
        evidenceDigest: bundle.contentHash,
        payloadHash: '',
        sharingLevel: 'approved-full',
        verifyStatus: 'verified',
        protocolStatus: bundle.core.verdict.protocolStatus,
        dataStatus: bundle.core.verdict.dataStatus,
        observedAt: new Date(bundle.core.completeness.observedAt),
        expiresAt: new Date(bundle.core.completeness.expiresAt),
        payload: bundle,
      };
    } else {
      const m = object(body['body']);
      const keys = [
        'deploymentId',
        'evidenceHash',
        'schemaVersion',
        'protocolStatus',
        'dataStatus',
        'claimMode',
        'coverage',
        'reasonCodes',
        'observedAt',
        'expiresAt',
        'fresh',
        'chainCount',
        'ruleCount',
        'messageCount',
      ];
      if (
        m === null ||
        !exact(m, keys) ||
        typeof m['deploymentId'] !== 'string' ||
        !ID.test(m['deploymentId']) ||
        typeof m['evidenceHash'] !== 'string' ||
        !DIGEST.test(m['evidenceHash']) ||
        typeof m['schemaVersion'] !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(m['schemaVersion']) ||
        !member(STATUSES, m['protocolStatus']) ||
        !member(DATA, m['dataStatus']) ||
        !member(CLAIM_MODES, m['claimMode']) ||
        !member(COVERAGE_STATES, m['coverage']) ||
        !iso(m['observedAt']) ||
        !iso(m['expiresAt']) ||
        !Array.isArray(m['reasonCodes']) ||
        !m['reasonCodes'].every(
          (v) => typeof v === 'string' && /^[A-Z][A-Z0-9_-]{1,63}$/.test(v),
        ) ||
        typeof m['fresh'] !== 'boolean' ||
        !['chainCount', 'ruleCount', 'messageCount'].every(
          (k) => Number.isSafeInteger(m[k]) && Number(m[k]) >= 0,
        )
      )
        return reply.code(400).send({ schemaVersion: API_VERSION, error: 'invalid-metadata' });
      input = {
        tenantId: identity.tenantId,
        deploymentId: m['deploymentId'],
        evidenceDigest: m['evidenceHash'],
        payloadHash: '',
        sharingLevel: 'sanitized-metadata',
        verifyStatus: 'metadata-only',
        protocolStatus: m['protocolStatus'],
        dataStatus: m['dataStatus'],
        observedAt: new Date(m['observedAt']),
        expiresAt: new Date(m['expiresAt']),
        payload: m,
      };
    }
    const grant = await options.store.grant(identity.tenantId, input.deploymentId);
    const permitted =
      grant !== null &&
      grant.sharingLevel !== 'local-only' &&
      (grant.sharingLevel === 'approved-full' || input.sharingLevel === 'sanitized-metadata');
    if (!permitted) {
      await audit(request, identity, 'ingest:write', 'denied', 404);
      return reply.code(404).send({ schemaVersion: API_VERSION, error: 'not-found' });
    }
    if (input.expiresAt <= input.observedAt)
      return reply
        .code(400)
        .send({ schemaVersion: API_VERSION, error: 'invalid-freshness-window' });
    input = {
      ...input,
      payloadHash: domainSeparatedSha256(
        'ictt-sentinel/hosted-ingest/v1',
        canonicalStringify(body),
      ),
    };
    try {
      const result = await options.store.ingest(
        input,
        key,
        new Date(now().getTime() + 24 * 60 * 60 * 1000),
      );
      await audit(request, identity, 'ingest:write', 'allowed', result.status);
      return await reply.code(result.status).send(result.body);
    } catch {
      await audit(request, identity, 'ingest:write', 'denied', 409);
      return reply.code(409).send({ schemaVersion: API_VERSION, error: 'idempotency-conflict' });
    }
  });
  app.post('/v1/alerts/:incidentKey/acknowledge', async (request, reply) => {
    const identity = await authorize(request, reply, 'alerts:ack');
    if (identity === null) return;
    const key = object(request.params)?.['incidentKey'];
    if (typeof key !== 'string' || !DIGEST.test(key))
      return reply.code(404).send({ schemaVersion: API_VERSION, error: 'not-found' });
    const count = await options.store.acknowledge(identity.tenantId, key, identity.tokenId, now());
    await audit(
      request,
      identity,
      'alerts:ack',
      count > 0 ? 'allowed' : 'denied',
      count > 0 ? 200 : 404,
    );
    return reply
      .code(count > 0 ? 200 : 404)
      .send(
        count > 0 ? { acknowledged: true } : { schemaVersion: API_VERSION, error: 'not-found' },
      );
  });

  app.post('/v1/webhooks/:tenantId/:sourceId/hints', async (request, reply) => {
    const params = object(request.params),
      tenant = params?.['tenantId'],
      source = params?.['sourceId'];
    const stamp = request.headers['x-ictt-timestamp'],
      nonce = request.headers['x-ictt-nonce'],
      signature = request.headers['x-ictt-signature'];
    const raw = request.body;
    if (
      typeof tenant !== 'string' ||
      !SEGMENT.test(tenant) ||
      typeof source !== 'string' ||
      !SEGMENT.test(source) ||
      typeof stamp !== 'string' ||
      !/^[0-9]{10,13}$/.test(stamp) ||
      typeof nonce !== 'string' ||
      !NONCE.test(nonce) ||
      typeof signature !== 'string' ||
      !SIGNATURE.test(signature) ||
      !(raw instanceof Buffer)
    )
      return reply.code(401).send({ schemaVersion: API_VERSION, error: 'invalid-webhook' });
    const signedAt = new Date(Number(stamp));
    if (
      !Number.isFinite(signedAt.getTime()) ||
      Math.abs(now().getTime() - signedAt.getTime()) > 300_000
    )
      return reply.code(401).send({ schemaVersion: API_VERSION, error: 'invalid-webhook' });
    const secret = options.webhookSecret?.(tenant, source);
    const expected =
      secret === undefined
        ? Buffer.alloc(32)
        : createHmac('sha256', secret)
            .update(stamp)
            .update('.')
            .update(nonce)
            .update('.')
            .update(raw)
            .digest();
    const presented = Buffer.from(signature, 'hex');
    if (secret === undefined || !timingSafeEqual(expected, presented))
      return reply.code(401).send({ schemaVersion: API_VERSION, error: 'invalid-webhook' });
    let body: Record<string, unknown> | null = null;
    try {
      body = object(JSON.parse(raw.toString('utf8')));
    } catch {
      /* rejected below */
    }
    if (
      body === null ||
      !exact(body, ['deploymentId', 'chainKey', 'suggestedBlockNumber']) ||
      typeof body['deploymentId'] !== 'string' ||
      !ID.test(body['deploymentId']) ||
      typeof body['chainKey'] !== 'string' ||
      !ID.test(body['chainKey']) ||
      typeof body['suggestedBlockNumber'] !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(body['suggestedBlockNumber']) ||
      body['suggestedBlockNumber'].length > 78
    )
      return reply.code(400).send({ schemaVersion: API_VERSION, error: 'invalid-hint' });
    if (!rate.take(`hook/${tenant}/${source}`, now().getTime()))
      return reply.code(429).send({ schemaVersion: API_VERSION, error: 'rate-limited' });
    const fresh = await options.store.claimNonce(
      tenant,
      nonce,
      signedAt,
      new Date(signedAt.getTime() + 300_000),
    );
    if (!fresh)
      return reply.code(409).send({ schemaVersion: API_VERSION, error: 'webhook-replay' });
    const dedup = domainSeparatedSha256(
      'ictt-sentinel/webhook-hint/v1',
      `${tenant}/${source}/${body['deploymentId']}/${body['chainKey']}/${body['suggestedBlockNumber']}`,
    );
    const queued = await options.store.enqueueHint(tenant, {
      hintId: dedup,
      deploymentId: body['deploymentId'],
      chainKey: body['chainKey'],
      suggestedBlockNumber: BigInt(body['suggestedBlockNumber']),
      source: `webhook:${source}`,
      dedupKey: dedup,
      receivedAt: now(),
    });
    return reply
      .code(202)
      .send({ accepted: true, duplicateHint: !queued, effect: 'bounded-priority-hint-only' });
  });
  return app;
};
