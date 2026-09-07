import { createHash } from 'node:crypto';
import type { Verdict } from '@ictt-sentinel/domain';
import type { Db } from './client.js';
import { IdempotencyConflictError } from './errors.js';

/**
 * Append-only judgement writes.
 *
 * An evaluation is addressed by what it was computed from, never by when it ran
 * or by a fresh UUID. That is the whole idempotency story: the same work retried
 * after a crash lands on the same key and changes nothing.
 */

export interface PinnedBlock {
  readonly chainKey: string;
  readonly blockNumber: bigint;
  /** Both halves are required; a number alone is not an identity after a reorg. */
  readonly blockHash: string;
}

export interface EvaluationInput {
  readonly deploymentId: string;
  readonly subject: string;
  readonly policyVersion: string;
  readonly adapterVersion: string;
  readonly pinnedBlocks: readonly PinnedBlock[];
  /** Digests of the observations the verdict was computed from. */
  readonly inputObservationDigests: readonly string[];
}

export interface EvaluationRecord extends EvaluationInput {
  readonly verdict: Verdict;
  readonly payloadDigest: string;
}

export interface EvaluationWriteResult {
  readonly evaluationId: string;
  readonly idempotencyKey: string;
  /** False when an identical evaluation was already stored. */
  readonly inserted: boolean;
}

/**
 * Content-addressed idempotency key.
 *
 * Pinned blocks and input digests are sorted before hashing, so the same evidence
 * gathered in a different order yields the same key. Nothing time-based or random
 * enters: if it did, a retry would mint a second verdict for one set of facts.
 */
export const evaluationIdempotencyKey = (input: EvaluationInput): string => {
  const pinned = [...input.pinnedBlocks]
    .map((p) => `${p.chainKey}@${p.blockNumber.toString(10)}:${p.blockHash}`)
    .sort();
  const digests = [...input.inputObservationDigests].sort();
  return createHash('sha256')
    .update(
      JSON.stringify({
        deploymentId: input.deploymentId,
        subject: input.subject,
        policyVersion: input.policyVersion,
        adapterVersion: input.adapterVersion,
        pinned,
        digests,
      }),
    )
    .digest('hex');
};

const pinnedBlocksJson = (pinned: readonly PinnedBlock[]): unknown =>
  [...pinned]
    .map((p) => ({
      chainKey: p.chainKey,
      // Serialised as a decimal string: JSON numbers are doubles and a height
      // above 2^53 would come back wrong.
      blockNumber: p.blockNumber.toString(10),
      blockHash: p.blockHash,
    }))
    .sort((a, b) => (a.chainKey < b.chainKey ? -1 : a.chainKey > b.chainKey ? 1 : 0));

/**
 * Write an evaluation, or confirm the identical one already exists.
 *
 * Same key + same payload digest is a no-op. Same key + a different payload is an
 * IdempotencyConflictError, never an overwrite: it means the key does not cover
 * an input the verdict actually depended on, and quietly replacing the stored
 * verdict would destroy the evidence that they disagreed.
 */
export const putEvaluation = async (
  db: Db,
  record: EvaluationRecord,
): Promise<EvaluationWriteResult> => {
  const idempotencyKey = evaluationIdempotencyKey(record);
  const evaluationId = idempotencyKey;
  const inputDigest = createHash('sha256')
    .update([...record.inputObservationDigests].sort().join(''))
    .digest('hex');

  const inserted = await db.sql<{ evaluation_id: string }[]>`
    insert into evaluations
      (evaluation_id, idempotency_key, deployment_id, subject, policy_version, adapter_version,
       pinned_blocks, input_digest, verdict, payload_digest)
    values
      (${evaluationId}, ${idempotencyKey}, ${record.deploymentId}, ${record.subject},
       ${record.policyVersion}, ${record.adapterVersion},
       ${db.sql.json(pinnedBlocksJson(record.pinnedBlocks) as never)},
       ${inputDigest}, ${record.verdict}, ${record.payloadDigest})
    on conflict (idempotency_key) do nothing
    returning evaluation_id
  `;

  if (inserted.length > 0) {
    return { evaluationId, idempotencyKey, inserted: true };
  }

  const existing = await db.sql<{ evaluation_id: string; payload_digest: string }[]>`
    select evaluation_id, payload_digest from evaluations where idempotency_key = ${idempotencyKey}
  `;
  const row = existing[0];
  if (!row) throw new Error('evaluation vanished between insert and read');
  if (row.payload_digest !== record.payloadDigest) {
    throw new IdempotencyConflictError(idempotencyKey, row.payload_digest, record.payloadDigest);
  }
  return { evaluationId: row.evaluation_id, idempotencyKey, inserted: false };
};

/** Append a verdict event. UNKNOWN is stored as UNKNOWN and never folded into OK. */
export const appendVerdictEvent = async (
  db: Db,
  args: {
    eventId: string;
    evaluationId: string;
    verdict: Verdict;
    reasonCode: string;
    detail: unknown;
  },
): Promise<void> => {
  await db.sql`
    insert into verdict_events (event_id, evaluation_id, verdict, reason_code, detail)
    values (${args.eventId}, ${args.evaluationId}, ${args.verdict}, ${args.reasonCode},
            ${db.sql.json(args.detail as never)})
    on conflict (event_id) do nothing
  `;
};
