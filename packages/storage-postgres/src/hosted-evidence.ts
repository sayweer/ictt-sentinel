import type { Db, Tx } from './client.js';
import { advisoryLockKey } from './client.js';
import { IdempotencyPayloadConflictError, type StoredResponse } from './hosted-store.js';

export type HostedSharingLevel = 'sanitized-metadata' | 'approved-full';
export type HostedVerifyStatus = 'verified' | 'metadata-only';

export interface HostedEvaluationInput {
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly evidenceDigest: string;
  readonly payloadHash: string;
  readonly sharingLevel: HostedSharingLevel;
  readonly verifyStatus: HostedVerifyStatus;
  readonly protocolStatus: 'OK' | 'WARN' | 'UNKNOWN' | 'CRITICAL';
  readonly dataStatus: 'COMPLETE' | 'STALE' | 'PARTIAL' | 'DIVERGENT' | 'UNKNOWN';
  readonly observedAt: Date;
  readonly expiresAt: Date;
  readonly payload: unknown;
}

export interface HostedEvaluationRow extends HostedEvaluationInput {
  readonly receivedAt: Date;
}

interface Columns {
  tenant_id: string;
  deployment_id: string;
  evidence_digest: string;
  payload_hash: string;
  sharing_level: HostedSharingLevel;
  verify_status: HostedVerifyStatus;
  protocol_status: HostedEvaluationInput['protocolStatus'];
  data_status: HostedEvaluationInput['dataStatus'];
  observed_at: Date;
  expires_at: Date;
  payload: unknown;
  received_at: Date;
}
const row = (r: Columns): HostedEvaluationRow => ({
  tenantId: r.tenant_id,
  deploymentId: r.deployment_id,
  evidenceDigest: r.evidence_digest,
  payloadHash: r.payload_hash,
  sharingLevel: r.sharing_level,
  verifyStatus: r.verify_status,
  protocolStatus: r.protocol_status,
  dataStatus: r.data_status,
  observedAt: r.observed_at,
  expiresAt: r.expires_at,
  payload: r.payload,
  receivedAt: r.received_at,
});

/** The idempotency decision, hosted record and remembered answer share one lock and transaction. */
export const ingestHostedEvaluation = async (
  db: Db,
  input: HostedEvaluationInput,
  idempotencyKey: string,
  idempotencyExpiresAt: Date,
): Promise<{ readonly duplicate: boolean; readonly response: StoredResponse }> =>
  db.sql.begin(async (tx: Tx) => {
    const [a, b] = advisoryLockKey(`hosted/${input.tenantId}/${idempotencyKey}`);
    await tx`select pg_advisory_xact_lock(${a}::int, ${b}::int)`;
    const remembered = await tx<
      {
        payload_hash: string;
        route: string;
        response_status: number;
        response_body: unknown;
      }[]
    >`
      select payload_hash, route, response_status, response_body from api_idempotency
      where tenant_id = ${input.tenantId} and idempotency_key = ${idempotencyKey} for update
    `;
    const prior = remembered[0];
    if (prior !== undefined) {
      if (prior.payload_hash !== input.payloadHash || prior.route !== 'POST /v1/ingest/evaluations')
        throw new IdempotencyPayloadConflictError(idempotencyKey);
      return {
        duplicate: true,
        response: { status: prior.response_status, body: prior.response_body },
      };
    }
    const existing = await tx<{ payload_hash: string }[]>`
      select payload_hash from hosted_evaluations
      where tenant_id = ${input.tenantId} and deployment_id = ${input.deploymentId}
        and evidence_digest = ${input.evidenceDigest} for update
    `;
    if (existing[0] !== undefined && existing[0].payload_hash !== input.payloadHash)
      throw new IdempotencyPayloadConflictError(idempotencyKey);
    const duplicate = existing[0] !== undefined;
    if (!duplicate)
      await tx`
      insert into hosted_evaluations
        (tenant_id, deployment_id, evidence_digest, payload_hash, sharing_level,
         verify_status, protocol_status, data_status, observed_at, expires_at, payload)
      values (${input.tenantId}, ${input.deploymentId}, ${input.evidenceDigest},
        ${input.payloadHash}, ${input.sharingLevel}, ${input.verifyStatus},
        ${input.protocolStatus}, ${input.dataStatus}, ${input.observedAt}, ${input.expiresAt},
        ${tx.json(input.payload as never)})
    `;
    const response: StoredResponse = {
      status: duplicate ? 200 : 201,
      body: { accepted: true, duplicate, evidenceDigest: input.evidenceDigest },
    };
    await tx`
      insert into api_idempotency
        (tenant_id, idempotency_key, route, payload_hash, response_status, response_body, expires_at)
      values (${input.tenantId}, ${idempotencyKey}, 'POST /v1/ingest/evaluations',
        ${input.payloadHash}, ${response.status}, ${tx.json(response.body as never)},
        ${idempotencyExpiresAt})
    `;
    return { duplicate, response };
  });

export const readHostedEvaluations = async (
  db: Db,
  tenantId: string,
  deploymentId: string,
  limit: number,
  after: string | null,
): Promise<readonly HostedEvaluationRow[]> => {
  const rows = await db.sql<Columns[]>`
    select tenant_id, deployment_id, evidence_digest, payload_hash, sharing_level,
      verify_status, protocol_status, data_status, observed_at, expires_at, payload, received_at
    from hosted_evaluations h
    where tenant_id = ${tenantId} and deployment_id = ${deploymentId}
      and (${after}::text is null or (h.observed_at, h.evidence_digest) < (
        select c.observed_at, c.evidence_digest from hosted_evaluations c
        where c.tenant_id = ${tenantId} and c.deployment_id = ${deploymentId}
          and c.evidence_digest = ${after}))
    order by observed_at desc, evidence_digest desc limit ${limit}
  `;
  return rows.map(row);
};

export const readHostedEvaluation = async (
  db: Db,
  tenantId: string,
  deploymentId: string,
  evidenceDigest: string,
): Promise<HostedEvaluationRow | null> => {
  const rows = await db.sql<Columns[]>`
    select tenant_id, deployment_id, evidence_digest, payload_hash, sharing_level,
      verify_status, protocol_status, data_status, observed_at, expires_at, payload, received_at
    from hosted_evaluations where tenant_id = ${tenantId} and deployment_id = ${deploymentId}
      and evidence_digest = ${evidenceDigest}
  `;
  return rows[0] === undefined ? null : row(rows[0]);
};
