import { createHash } from 'node:crypto';
import {
  checkTargetUrl,
  project,
  type SharedEvidence,
  type SharingLevel,
} from '@ictt-sentinel/alerts';
import { redact, type EvidenceBundle } from '@ictt-sentinel/evidence';

/**
 * Hosted-plane ingest.
 *
 * Optional by construction. The local agent is the truth authority: it
 * evaluates, it writes evidence, and it alerts, all without this file ever
 * succeeding. Ingest is a mirror, and a broken mirror is a mirror problem
 * (docs/ARCHITECTURE.md 2).
 *
 * Three properties:
 *
 *   idempotent      the key is derived from the evidence content, so the same
 *                   bundle retried after a timeout is recognised as the same
 *                   submission rather than stored twice.
 *   level-gated     what is sent is whatever `sharingLevel` permits and nothing
 *                   more. `local-only` does not reach the network at all.
 *   never a verdict this returns an outcome. No branch of it can change what the
 *                   local evaluation concluded.
 */

export type IngestOutcome =
  | 'sent'
  | 'duplicate'
  | 'disabled'
  | 'refused'
  | 'unauthorized'
  | 'conflict'
  | 'unreachable';

export interface IngestReport {
  readonly outcome: IngestOutcome;
  readonly idempotencyKey: string | null;
  /** Redacted and bounded. Never the response body, never the URL. */
  readonly reason: string;
}

/**
 * Content-addressed idempotency key.
 *
 * No clock and no counter: two agents, or one agent across a restart, must
 * derive the same key for the same evidence, or a retry becomes a second record.
 */
export const ingestIdempotencyKey = (
  deploymentId: string,
  evidenceHash: string,
  level: SharingLevel,
): string =>
  createHash('sha256')
    .update('ictt-sentinel/ingest/v1')
    .update('\n')
    .update([deploymentId, evidenceHash, level].join('|'))
    .digest('hex');

export interface IngestOptions {
  readonly hostedUrl: string | null;
  readonly token: string | undefined;
  readonly sharingLevel: SharingLevel;
  readonly bundle: EvidenceBundle;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly fetcher: typeof fetch;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export const ingest = async (options: IngestOptions): Promise<IngestReport> => {
  const { sharingLevel, bundle } = options;
  if (sharingLevel === 'local-only' || options.hostedUrl === null) {
    return { outcome: 'disabled', idempotencyKey: null, reason: 'sharing level is local-only' };
  }
  if (options.token === undefined || options.token === '') {
    return { outcome: 'unauthorized', idempotencyKey: null, reason: 'ingest token is not set' };
  }
  const check = checkTargetUrl(options.hostedUrl);
  if (!check.ok) {
    return {
      outcome: 'refused',
      idempotencyKey: null,
      reason: check.reason ?? 'hosted URL refused',
    };
  }

  const shared: SharedEvidence = project(sharingLevel, bundle);
  if (shared.body === null) {
    return { outcome: 'disabled', idempotencyKey: null, reason: 'nothing to share at this level' };
  }

  const key = ingestIdempotencyKey(bundle.core.deploymentId, bundle.contentHash, sharingLevel);
  const body = JSON.stringify({ level: shared.level, body: shared.body });
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    // Refused locally rather than sent and rejected: an oversized bundle is a
    // local fault and should not consume the hosted plane's request budget.
    return { outcome: 'refused', idempotencyKey: key, reason: 'payload exceeds the ingest limit' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);
  try {
    const response = await options.fetcher(new URL('/v1/ingest/evaluations', options.hostedUrl), {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        authorization: `Bearer ${options.token}`,
      },
      body,
      signal: AbortSignal.any([options.signal, controller.signal]),
    });
    if (response.status === 200) {
      return { outcome: 'duplicate', idempotencyKey: key, reason: 'already ingested' };
    }
    if (response.status === 201 || response.status === 202) {
      return { outcome: 'sent', idempotencyKey: key, reason: 'accepted' };
    }
    if (response.status === 401 || response.status === 403) {
      return { outcome: 'unauthorized', idempotencyKey: key, reason: 'ingest token was rejected' };
    }
    if (response.status === 409) {
      // The same key with a different payload. That is a real inconsistency and
      // it is surfaced, never retried into submission.
      return {
        outcome: 'conflict',
        idempotencyKey: key,
        reason: 'idempotency key reused with a different payload',
      };
    }
    return {
      outcome: 'unreachable',
      idempotencyKey: key,
      reason: `hosted plane returned ${String(response.status)}`,
    };
  } catch (e) {
    return {
      outcome: 'unreachable',
      idempotencyKey: key,
      reason: redact(e instanceof Error ? e.message : 'ingest failed').slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
};
