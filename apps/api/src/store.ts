import type { EvidenceBundle } from '@ictt-sentinel/evidence';

export interface ApiIdentity {
  readonly tokenId: string;
  readonly tenantId: string;
  readonly scopes: readonly string[];
}
export interface ApiGrant {
  readonly deploymentId: string;
  readonly tenantId: string;
  readonly sharingLevel: 'local-only' | 'sanitized-metadata' | 'approved-full';
}
export interface HostedRecord {
  readonly deploymentId: string;
  readonly evidenceDigest: string;
  readonly sharingLevel: 'sanitized-metadata' | 'approved-full';
  readonly verifyStatus: 'verified' | 'metadata-only';
  readonly protocolStatus: 'OK' | 'WARN' | 'UNKNOWN' | 'CRITICAL';
  readonly dataStatus: 'COMPLETE' | 'STALE' | 'PARTIAL' | 'DIVERGENT' | 'UNKNOWN';
  readonly observedAt: Date;
  readonly expiresAt: Date;
  readonly receivedAt: Date;
  readonly payload: unknown;
}
export interface HostedWrite extends Omit<HostedRecord, 'receivedAt'> {
  readonly tenantId: string;
  readonly payloadHash: string;
}
export interface ApiStore {
  ready(): Promise<boolean>;
  authenticate(tokenHash: string, now: Date): Promise<ApiIdentity | null>;
  grant(tenantId: string, deploymentId: string): Promise<ApiGrant | null>;
  grants(tenantId: string, limit: number, after: string | null): Promise<readonly ApiGrant[]>;
  timeline(
    tenantId: string,
    deploymentId: string,
    limit: number,
    after: string | null,
  ): Promise<readonly HostedRecord[]>;
  evidence(tenantId: string, deploymentId: string, digest: string): Promise<HostedRecord | null>;
  ingest(
    input: HostedWrite,
    idempotencyKey: string,
    expiresAt: Date,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  acknowledge(tenantId: string, incidentKey: string, by: string, at: Date): Promise<number>;
  claimNonce(tenantId: string, nonce: string, signedAt: Date, expiresAt: Date): Promise<boolean>;
  enqueueHint(
    tenantId: string,
    input: {
      readonly hintId: string;
      readonly deploymentId: string;
      readonly chainKey: string;
      readonly suggestedBlockNumber: bigint;
      readonly source: string;
      readonly dedupKey: string;
      readonly receivedAt: Date;
    },
  ): Promise<boolean>;
  audit(input: {
    readonly auditId: string;
    readonly tenantId: string | null;
    readonly tokenId: string | null;
    readonly requestId: string;
    readonly action: string;
    readonly resource: string;
    readonly outcome: 'allowed' | 'denied' | 'error';
    readonly statusCode: number;
    readonly detail: unknown;
  }): Promise<void>;
}

export const fullBundle = (record: HostedRecord): EvidenceBundle | null =>
  record.sharingLevel === 'approved-full' &&
  record.payload !== null &&
  typeof record.payload === 'object' &&
  !Array.isArray(record.payload)
    ? (record.payload as EvidenceBundle)
    : null;
