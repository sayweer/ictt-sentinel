import {
  acknowledgeTenantAlert,
  appendAudit,
  claimNonce,
  createDb,
  enqueueHint,
  findGrant,
  findTokenByHash,
  ingestHostedEvaluation,
  listGrants,
  readHostedEvaluation,
  readHostedEvaluations,
  type Db,
} from '@ictt-sentinel/storage-postgres';
import type { ApiStore, HostedRecord } from './store.js';

const hosted = (r: Awaited<ReturnType<typeof readHostedEvaluations>>[number]): HostedRecord => ({
  deploymentId: r.deploymentId,
  evidenceDigest: r.evidenceDigest,
  sharingLevel: r.sharingLevel,
  verifyStatus: r.verifyStatus,
  protocolStatus: r.protocolStatus,
  dataStatus: r.dataStatus,
  observedAt: r.observedAt,
  expiresAt: r.expiresAt,
  receivedAt: r.receivedAt,
  payload: r.payload,
});

export const postgresStore = (db: Db): ApiStore => ({
  ready: async () => {
    try {
      const rows = await db.sql`select to_regclass('hosted_evaluations') is not null as ready`;
      return rows[0]?.['ready'] === true;
    } catch {
      return false;
    }
  },
  authenticate: (hash, now) => findTokenByHash(db, hash, now),
  grant: (tenant, deployment) => findGrant(db, tenant, deployment),
  grants: (tenant, limit, after) => listGrants(db, tenant, limit, after),
  timeline: async (tenant, deployment, limit, after) =>
    (await readHostedEvaluations(db, tenant, deployment, limit, after)).map(hosted),
  evidence: async (tenant, deployment, digest) => {
    const value = await readHostedEvaluation(db, tenant, deployment, digest);
    return value === null ? null : hosted(value);
  },
  ingest: async (input, key, expiry) =>
    (await ingestHostedEvaluation(db, input, key, expiry)).response,
  acknowledge: (tenant, incident, by, at) => acknowledgeTenantAlert(db, tenant, incident, by, at),
  claimNonce: (tenant, nonce, signed, expiry) => claimNonce(db, tenant, nonce, signed, expiry),
  enqueueHint: async (tenant, input) => {
    if ((await findGrant(db, tenant, input.deploymentId)) === null) return false;
    return enqueueHint(db, { ...input, source: 'webhook' });
  },
  audit: (input) => appendAudit(db, input),
});

export const openPostgresStore = (
  dsn: string,
): { readonly store: ApiStore; close(): Promise<void> } => {
  const db = createDb(dsn);
  return { store: postgresStore(db), close: () => db.close() };
};
