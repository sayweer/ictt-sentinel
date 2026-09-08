import type { EvidenceBundle } from '@ictt-sentinel/evidence';
import {
  DATA_STATUSES,
  PROTOCOL_STATUSES,
  SHARING_LEVELS,
  VERIFY_STATUSES,
  type DataStatus,
  type DeploymentGrant,
  type DeploymentStatus,
  type EvidenceDetailResponse,
  type EvidenceRecord,
  type MessageRow,
  type ProtocolStatus,
  type SharingLevel,
  type VerifyStatus,
} from './contract.js';

/**
 * Decoding, not casting.
 *
 * Everything crossing this boundary is untrusted. Not because the hosted API is
 * hostile, but because what it stores was uploaded by an agent and describes
 * contracts an attacker may control: a token symbol, a rule id, a reason string.
 * A response that does not match the contract is refused here rather than
 * rendered half-formed three components deep.
 *
 * Strings are also LENGTH-BOUNDED. React escapes markup, so a hostile symbol
 * cannot become script - but a megabyte-long "reason code" is still a way to
 * make a table unreadable, and refusing it costs nothing.
 */

export class ContractError extends Error {
  override readonly name = 'ContractError';
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`response does not match the API contract at ${path}: ${detail}`);
    this.path = path;
  }
}

const MAX_STRING = 512;
const MAX_ITEMS = 500;

const object = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractError(path, 'expected an object');
  }
  return value as Record<string, unknown>;
};

export const text = (value: unknown, path: string, max = MAX_STRING): string => {
  if (typeof value !== 'string') throw new ContractError(path, 'expected a string');
  if (value.length > max) throw new ContractError(path, `longer than ${String(max)} characters`);
  return value;
};

const integer = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ContractError(path, 'expected a non-negative safe integer');
  }
  return value;
};

const oneOf = <T extends string>(values: readonly T[], value: unknown, path: string): T => {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new ContractError(path, `expected one of ${values.join(', ')}`);
  }
  return value as T;
};

/** ISO-8601 in UTC, exactly as the API emits it. A local-time string is refused. */
export const instant = (value: unknown, path: string): string => {
  const raw = text(value, path, 64);
  if (!Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString() !== raw) {
    throw new ContractError(path, 'expected a canonical ISO-8601 UTC timestamp');
  }
  return raw;
};

const digest = (value: unknown, path: string): string => {
  const raw = text(value, path, 64);
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new ContractError(path, 'expected a sha256 digest');
  return raw;
};

/** Deployment ids reach the URL bar and the API path; the shape is enforced. */
export const deploymentId = (value: unknown, path: string): string => {
  const raw = text(value, path, 128);
  if (!/^[a-z0-9][a-z0-9._/-]{0,126}$/.test(raw) || raw.includes('..')) {
    throw new ContractError(path, 'not a valid deployment id');
  }
  return raw;
};

const list = <T>(
  value: unknown,
  path: string,
  item: (v: unknown, p: string) => T,
): readonly T[] => {
  if (!Array.isArray(value)) throw new ContractError(path, 'expected an array');
  if (value.length > MAX_ITEMS)
    throw new ContractError(path, `more than ${String(MAX_ITEMS)} items`);
  return value.map((v: unknown, i) => item(v, `${path}[${String(i)}]`));
};

export const evidenceRecord = (value: unknown, path = 'record'): EvidenceRecord => {
  const r = object(value, path);
  return {
    deploymentId: deploymentId(r['deploymentId'], `${path}.deploymentId`),
    evidenceDigest: digest(r['evidenceDigest'], `${path}.evidenceDigest`),
    sharingLevel: oneOf(
      ['sanitized-metadata', 'approved-full'] as const,
      r['sharingLevel'],
      `${path}.sharingLevel`,
    ),
    verifyStatus: oneOf<VerifyStatus>(VERIFY_STATUSES, r['verifyStatus'], `${path}.verifyStatus`),
    protocolStatus: oneOf<ProtocolStatus>(
      PROTOCOL_STATUSES,
      r['protocolStatus'],
      `${path}.protocolStatus`,
    ),
    dataStatus: oneOf<DataStatus>(DATA_STATUSES, r['dataStatus'], `${path}.dataStatus`),
    observedAt: instant(r['observedAt'], `${path}.observedAt`),
    expiresAt: instant(r['expiresAt'], `${path}.expiresAt`),
    receivedAt: instant(r['receivedAt'], `${path}.receivedAt`),
  };
};

export const deploymentStatus = (value: unknown, path = 'status'): DeploymentStatus => {
  const r = object(value, path);
  const base = evidenceRecord(value, path);
  if (typeof r['stale'] !== 'boolean')
    throw new ContractError(`${path}.stale`, 'expected a boolean');
  return {
    ...base,
    stale: r['stale'],
    currentProtocolStatus: oneOf<ProtocolStatus>(
      PROTOCOL_STATUSES,
      r['currentProtocolStatus'],
      `${path}.currentProtocolStatus`,
    ),
    currentDataStatus: oneOf<DataStatus>(
      DATA_STATUSES,
      r['currentDataStatus'],
      `${path}.currentDataStatus`,
    ),
  };
};

export const grant = (value: unknown, path = 'grant'): DeploymentGrant => {
  const r = object(value, path);
  return {
    deploymentId: deploymentId(r['deploymentId'], `${path}.deploymentId`),
    tenantId: text(r['tenantId'], `${path}.tenantId`, 64),
    sharingLevel: oneOf<SharingLevel>(SHARING_LEVELS, r['sharingLevel'], `${path}.sharingLevel`),
  };
};

export const messageRow = (value: unknown, path = 'message'): MessageRow => {
  const r = object(value, path);
  return {
    evidenceDigest: digest(r['evidenceDigest'], `${path}.evidenceDigest`),
    sourceBlockchainId: text(r['sourceBlockchainId'], `${path}.sourceBlockchainId`, 66),
    destinationBlockchainId: text(
      r['destinationBlockchainId'],
      `${path}.destinationBlockchainId`,
      66,
    ),
    teleporterMessengerAddress: text(
      r['teleporterMessengerAddress'],
      `${path}.teleporterMessengerAddress`,
      42,
    ),
    registryProtocolVersion: integer(
      r['registryProtocolVersion'],
      `${path}.registryProtocolVersion`,
    ),
    messageId: text(r['messageId'], `${path}.messageId`, 66),
    state: text(r['state'], `${path}.state`, 64),
    timeline: list(r['timeline'], `${path}.timeline`, (v, p) => {
      const t = object(v, p);
      return {
        kind: text(t['kind'], `${p}.kind`, 64),
        factDigest: text(t['factDigest'], `${p}.factDigest`, 64),
      };
    }),
    sendAttempts: integer(r['sendAttempts'], `${path}.sendAttempts`),
    executionAttempts: integer(r['executionAttempts'], `${path}.executionAttempts`),
    envelopeIds: list(r['envelopeIds'], `${path}.envelopeIds`, (v, p) => text(v, p, 66)),
    economicEffectCount: integer(r['economicEffectCount'], `${path}.economicEffectCount`),
  };
};

const cursor = (value: unknown, path: string): string | null =>
  value === null ? null : text(value, path, 128);

export const listDeployments = (
  value: unknown,
): { items: readonly DeploymentGrant[]; next: string | null } => {
  const r = object(value, 'body');
  return {
    items: list(r['deployments'], 'body.deployments', grant),
    next: cursor(r['next'], 'body.next'),
  };
};

export const statusResponse = (value: unknown): DeploymentStatus | null => {
  const r = object(value, 'body');
  return r['status'] === null ? null : deploymentStatus(r['status'], 'body.status');
};

export const timelineResponse = (
  value: unknown,
): { items: readonly EvidenceRecord[]; next: string | null } => {
  const r = object(value, 'body');
  return {
    items: list(r['items'], 'body.items', evidenceRecord),
    next: cursor(r['next'], 'body.next'),
  };
};

export const evidenceListResponse = (
  value: unknown,
): { items: readonly EvidenceRecord[]; next: string | null } => {
  const r = object(value, 'body');
  return {
    items: list(r['evidence'], 'body.evidence', evidenceRecord),
    next: cursor(r['next'], 'body.next'),
  };
};

export const messagesResponse = (value: unknown): readonly MessageRow[] => {
  const r = object(value, 'body');
  return list(r['messages'], 'body.messages', messageRow);
};

/**
 * Evidence detail.
 *
 * The bundle is deliberately NOT decoded field by field. The console does not
 * re-derive a verdict from it and must not imply that it validated it; it
 * displays the server's `verifyStatus` and offers the bytes for offline
 * verification with the CLI. What is checked is the one thing the screen relies
 * on: that it is an object carrying a content hash.
 */
export const evidenceDetail = (value: unknown): EvidenceDetailResponse => {
  const r = object(value, 'body');
  const metadata = evidenceRecord(r['metadata'], 'body.metadata');
  const raw = r['bundle'];
  if (raw === null || raw === undefined) return { schemaVersion: '', metadata, bundle: null };
  const b = object(raw, 'body.bundle');
  digest(b['contentHash'], 'body.bundle.contentHash');
  object(b['core'], 'body.bundle.core');
  return { schemaVersion: '', metadata, bundle: raw as EvidenceBundle };
};
