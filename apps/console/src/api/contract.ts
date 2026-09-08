import type { EvidenceBundle } from '@ictt-sentinel/evidence';

/**
 * The hosted API contract, as the console sees it.
 *
 * Mirrors `apps/api` exactly. The console is a viewer: it does not widen this
 * shape for its own convenience, and where a screen wants a field the API does
 * not publish, the screen says so rather than inventing one.
 *
 * Nothing here can express a write to a chain. There is no signer, no
 * transaction, no RPC endpoint and no provider token in any of these types -
 * a browser that cannot name those things cannot leak them.
 */

export const API_VERSION = 'ictt-sentinel/hosted-api/v1' as const;

export const PROTOCOL_STATUSES = ['OK', 'WARN', 'UNKNOWN', 'CRITICAL'] as const;
export type ProtocolStatus = (typeof PROTOCOL_STATUSES)[number];

export const DATA_STATUSES = ['COMPLETE', 'STALE', 'PARTIAL', 'DIVERGENT', 'UNKNOWN'] as const;
export type DataStatus = (typeof DATA_STATUSES)[number];

export const SHARING_LEVELS = ['local-only', 'sanitized-metadata', 'approved-full'] as const;
export type SharingLevel = (typeof SHARING_LEVELS)[number];

export const VERIFY_STATUSES = ['verified', 'metadata-only'] as const;
export type VerifyStatus = (typeof VERIFY_STATUSES)[number];

/** One evidence record's public projection. Never carries a payload by itself. */
export interface EvidenceRecord {
  readonly deploymentId: string;
  readonly evidenceDigest: string;
  readonly sharingLevel: 'sanitized-metadata' | 'approved-full';
  readonly verifyStatus: VerifyStatus;
  readonly protocolStatus: ProtocolStatus;
  readonly dataStatus: DataStatus;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly receivedAt: string;
}

/**
 * Current status.
 *
 * `currentProtocolStatus` and `currentDataStatus` are the SERVER's freshness
 * decision, already applied. The console renders those, never the raw
 * `protocolStatus`, so a stale OK cannot be painted green by a client that
 * forgot to check `stale` (docs/adr/0003-fail-closed-verdicts.md).
 */
export interface DeploymentStatus extends EvidenceRecord {
  readonly stale: boolean;
  readonly currentProtocolStatus: ProtocolStatus;
  readonly currentDataStatus: DataStatus;
}

export interface DeploymentGrant {
  readonly deploymentId: string;
  readonly tenantId: string;
  readonly sharingLevel: SharingLevel;
}

export interface MessageRow {
  readonly evidenceDigest: string;
  readonly sourceBlockchainId: string;
  readonly destinationBlockchainId: string;
  readonly teleporterMessengerAddress: string;
  readonly registryProtocolVersion: number;
  readonly messageId: string;
  readonly state: string;
  readonly timeline: readonly { readonly kind: string; readonly factDigest: string }[];
  readonly sendAttempts: number;
  readonly executionAttempts: number;
  readonly envelopeIds: readonly string[];
  readonly economicEffectCount: number;
}

export interface ListDeploymentsResponse {
  readonly schemaVersion: string;
  readonly deployments: readonly DeploymentGrant[];
  readonly next: string | null;
}

export interface StatusResponse {
  readonly schemaVersion: string;
  readonly deploymentId: string;
  readonly status: DeploymentStatus | null;
}

export interface TimelineResponse {
  readonly schemaVersion: string;
  readonly items: readonly EvidenceRecord[];
  readonly next: string | null;
}

export interface MessagesResponse {
  readonly schemaVersion: string;
  readonly messages: readonly MessageRow[];
}

export interface EvidenceListResponse {
  readonly schemaVersion: string;
  readonly evidence: readonly EvidenceRecord[];
  readonly next: string | null;
}

/**
 * One evidence record with its bundle.
 *
 * `bundle` is `null` at `sanitized-metadata`. That is not an error and is not a
 * gap to paper over: the operator chose not to share it, and the screen says
 * exactly that.
 */
export interface EvidenceDetailResponse {
  readonly schemaVersion: string;
  readonly metadata: EvidenceRecord;
  readonly bundle: EvidenceBundle | null;
}

export interface ReadyResponse {
  readonly schemaVersion: string;
  readonly ready: boolean;
}
