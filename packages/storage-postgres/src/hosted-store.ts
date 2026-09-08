import type { Db } from './client.js';

/**
 * Persistence for the optional hosted plane.
 *
 * Everything here exists to answer three questions about a request, in this
 * order: who is calling, may they see this deployment, and have we already done
 * exactly this. None of it can grant a capability that writes to a chain - the
 * scope vocabulary is fixed by a CHECK constraint in migration 0006.
 */

export interface TokenIdentity {
  readonly tokenId: string;
  readonly tenantId: string;
  readonly scopes: readonly string[];
}

/**
 * Resolve a presented token by its hash.
 *
 * The caller hashes; this never sees the token itself. Expiry and revocation are
 * evaluated in SQL against the supplied instant rather than in the application,
 * so an expired token cannot be resurrected by a wrong clock in one process.
 */
export const findTokenByHash = async (
  db: Db,
  tokenHash: string,
  now: Date,
): Promise<TokenIdentity | null> => {
  const rows = await db.sql<{ token_id: string; tenant_id: string; scopes: string[] }[]>`
    select t.token_id, t.tenant_id, t.scopes
    from api_tokens t
    join tenants n on n.tenant_id = t.tenant_id
    where t.token_hash = ${tokenHash}
      and t.revoked_at is null
      and t.expires_at > ${now}
      and n.disabled_at is null
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return { tokenId: row.token_id, tenantId: row.tenant_id, scopes: row.scopes };
};

export interface DeploymentGrant {
  readonly deploymentId: string;
  readonly tenantId: string;
  readonly sharingLevel: 'local-only' | 'sanitized-metadata' | 'approved-full';
}

/**
 * Authorization for one deployment.
 *
 * Returns `null` both when the deployment does not exist and when it belongs to
 * someone else. The caller turns both into the same 404: distinguishing them
 * would turn this endpoint into an existence oracle for other tenants.
 */
export const findGrant = async (
  db: Db,
  tenantId: string,
  deploymentId: string,
): Promise<DeploymentGrant | null> => {
  const rows = await db.sql<
    { deployment_id: string; tenant_id: string; sharing_level: DeploymentGrant['sharingLevel'] }[]
  >`
    select deployment_id, tenant_id, sharing_level
    from deployment_tenants
    where tenant_id = ${tenantId} and deployment_id = ${deploymentId}
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    deploymentId: row.deployment_id,
    tenantId: row.tenant_id,
    sharingLevel: row.sharing_level,
  };
};

export const listGrants = async (
  db: Db,
  tenantId: string,
  limit: number,
  after: string | null,
): Promise<readonly DeploymentGrant[]> => {
  const rows = await db.sql<
    { deployment_id: string; tenant_id: string; sharing_level: DeploymentGrant['sharingLevel'] }[]
  >`
    select deployment_id, tenant_id, sharing_level
    from deployment_tenants
    where tenant_id = ${tenantId}
      and (${after}::text is null or deployment_id > ${after})
    order by deployment_id
    limit ${limit}
  `;
  return rows.map((r) => ({
    deploymentId: r.deployment_id,
    tenantId: r.tenant_id,
    sharingLevel: r.sharing_level,
  }));
};

// ------------------------------------------------------------- idempotency

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Raised when one key is reused with a different body. */
export class IdempotencyPayloadConflictError extends Error {
  override readonly name = 'IdempotencyPayloadConflictError';
  readonly idempotencyKey: string;
  constructor(idempotencyKey: string) {
    super(
      `idempotency key ${JSON.stringify(idempotencyKey)} was already used with a different payload`,
    );
    this.idempotencyKey = idempotencyKey;
  }
}

export type IdempotencyLookup =
  { readonly kind: 'fresh' } | { readonly kind: 'replay'; readonly response: StoredResponse };

/**
 * Claim an idempotency key for one payload.
 *
 * Three outcomes and no fourth: the key is new (`fresh`), the key is a repeat of
 * the identical payload (`replay`, answered from the record), or the key is a
 * repeat with a different payload, which throws. The third case is the one that
 * matters - accepting it would let a retried request silently overwrite the
 * evaluation the first one produced.
 */
export const claimIdempotency = async (
  db: Db,
  params: {
    readonly tenantId: string;
    readonly idempotencyKey: string;
    readonly route: string;
    readonly payloadHash: string;
  },
): Promise<IdempotencyLookup> => {
  const rows = await db.sql<
    { payload_hash: string; route: string; response_status: number; response_body: unknown }[]
  >`
    select payload_hash, route, response_status, response_body
    from api_idempotency
    where tenant_id = ${params.tenantId} and idempotency_key = ${params.idempotencyKey}
  `;
  const row = rows[0];
  if (row === undefined) return { kind: 'fresh' };
  if (row.payload_hash !== params.payloadHash || row.route !== params.route) {
    throw new IdempotencyPayloadConflictError(params.idempotencyKey);
  }
  return {
    kind: 'replay',
    response: { status: row.response_status, body: row.response_body },
  };
};

/** Persist the answer so a retry gets the same one. */
export const recordIdempotentResponse = async (
  db: Db,
  params: {
    readonly tenantId: string;
    readonly idempotencyKey: string;
    readonly route: string;
    readonly payloadHash: string;
    readonly response: StoredResponse;
    readonly expiresAt: Date;
  },
): Promise<void> => {
  await db.sql`
    insert into api_idempotency
      (tenant_id, idempotency_key, route, payload_hash, response_status, response_body, expires_at)
    values
      (${params.tenantId}, ${params.idempotencyKey}, ${params.route}, ${params.payloadHash},
       ${params.response.status}, ${db.sql.json(params.response.body as never)},
       ${params.expiresAt})
    on conflict (tenant_id, idempotency_key) do nothing
  `;
};

export const sweepIdempotency = async (db: Db, now: Date): Promise<number> => {
  const rows =
    await db.sql`delete from api_idempotency where expires_at <= ${now} returning tenant_id`;
  return rows.length;
};

// -------------------------------------------------------- webhook replay guard

/**
 * Remember a webhook nonce, or report that it was already seen.
 *
 * Returns false on a repeat. A valid signature is replayable forever without
 * this, and a webhook is the one inbound surface that is not under this
 * product's control (docs/SECURITY.md).
 */
export const claimNonce = async (
  db: Db,
  tenantId: string,
  nonce: string,
  signedAt: Date,
  expiresAt: Date,
): Promise<boolean> => {
  const rows = await db.sql`
    insert into webhook_nonces (tenant_id, nonce, signed_at, expires_at)
    values (${tenantId}, ${nonce}, ${signedAt}, ${expiresAt})
    on conflict (tenant_id, nonce) do nothing
    returning nonce
  `;
  return rows.length > 0;
};

export const sweepNonces = async (db: Db, now: Date): Promise<number> => {
  const rows = await db.sql`delete from webhook_nonces where expires_at <= ${now} returning nonce`;
  return rows.length;
};

// ------------------------------------------------------------------ audit log

export interface AuditEntry {
  readonly auditId: string;
  readonly tenantId: string | null;
  readonly tokenId: string | null;
  readonly requestId: string;
  readonly action: string;
  readonly resource: string;
  readonly outcome: 'allowed' | 'denied' | 'error';
  readonly statusCode: number;
  /** Structured, bounded and already redacted by the caller. */
  readonly detail: unknown;
}

/**
 * Append one audit entry.
 *
 * Deliberately swallows nothing: a failure to record an audit entry is a real
 * failure and the caller decides what to do. What it never does is copy the
 * request - no body, no headers, no query string - because an audit log that
 * mirrors the request is a second home for whatever credential was in it.
 */
export const appendAudit = async (db: Db, entry: AuditEntry): Promise<void> => {
  await db.sql`
    insert into api_audit_log
      (audit_id, tenant_id, token_id, request_id, action, resource, outcome, status_code, detail)
    values
      (${entry.auditId}, ${entry.tenantId}, ${entry.tokenId}, ${entry.requestId},
       ${entry.action}, ${entry.resource}, ${entry.outcome}, ${entry.statusCode},
       ${db.sql.json(entry.detail as never)})
    on conflict (audit_id) do nothing
  `;
};
