import { createHash } from 'node:crypto';
import {
  type Db,
  AcceptedHashConflictError,
  ingestBatch,
  readCheckpoint,
  readCommittedRanges,
  recordDataQualityIncident,
  recordRemoteCandidate,
  upsertCompleteness,
  upsertRangeStatus,
} from '@ictt-sentinel/storage-postgres';
import { type AgreementPolicy, agree, provenanceOf } from './agreement.js';
import { assessCompleteness, type ReplayStatus } from './completeness.js';
import { type RemoteCandidate } from './census.js';
import { type PriorityHint, prioritise } from './hints.js';
import { type BlockRange, type PlanInput, nextStep, planRanges, spanOf } from './plan.js';
import type { LogSourcePort } from './ports.js';
import { type RangeResult, classifyObservation } from './range.js';
import { REASON_METADATA, type ReplayReason } from './reasons.js';

/**
 * Replay orchestration.
 *
 * The single rule everything else serves: **facts and their checkpoint move
 * together, or not at all.** A range becomes history only after the required
 * number of independent provider groups returned byte-identical content for it;
 * anything short of that records a typed reason and leaves the checkpoint where
 * it was, so the next run replays the same range rather than skipping it.
 */

export interface ReplayConfig {
  readonly deploymentId: string;
  readonly chainKey: string;
  /** Manifest's trustworthy start block. Not "wherever history still exists". */
  readonly startBlock: bigint;
  readonly agreement: AgreementPolicy;
  readonly retryBudget: number;
  readonly freshnessTtlMs: number;
  /** Hints may reorder work; they can never add or remove a range. */
  readonly maxHintsConsidered: number;
}

export interface RangeReport {
  readonly range: BlockRange;
  readonly status: ReplayStatus;
  readonly reason: ReplayReason | null;
  readonly providerGroups: readonly string[];
  readonly digest: string | null;
}

export interface ReplayReport {
  readonly ranges: readonly RangeReport[];
  readonly acceptedHead: bigint;
  readonly checkpointBefore: bigint | null;
  readonly checkpointAfter: bigint | null;
  readonly gapCount: number;
  readonly status: ReplayStatus;
  readonly verdict: 'OK' | 'UNKNOWN' | 'WARN' | 'CRITICAL';
  readonly reasons: readonly ReplayReason[];
  readonly integrityConflict: boolean;
}

const rangeId = (deploymentId: string, chainKey: string, r: BlockRange): string =>
  createHash('sha256')
    .update(`${deploymentId}|${chainKey}|${r.fromBlock.toString(10)}|${r.toBlock.toString(10)}`)
    .digest('hex');

const incidentId = (
  deploymentId: string,
  chainKey: string,
  r: BlockRange,
  reason: ReplayReason,
): string =>
  createHash('sha256')
    .update(
      `${deploymentId}|${chainKey}|${r.fromBlock.toString(10)}|${r.toBlock.toString(10)}|${reason}`,
    )
    .digest('hex');

/**
 * Collect one range from every provider group, retrying and splitting inside the
 * declared budget.
 *
 * Returns either the agreed witnesses or the reason the range cannot be trusted.
 * Splitting produces sub-ranges the caller processes independently, which is how
 * a provider limit narrows the work instead of failing the whole window.
 */
const collectRange = async (
  port: LogSourcePort,
  config: ReplayConfig,
  range: BlockRange,
): Promise<
  | { readonly kind: 'agreed'; readonly results: readonly RangeResult[]; readonly digest: string }
  | { readonly kind: 'split'; readonly ranges: readonly BlockRange[] }
  | { readonly kind: 'blocked'; readonly reason: ReplayReason; readonly group: string | null }
> => {
  let attempts = 0;

  for (;;) {
    const results: RangeResult[] = [];
    let failure: { reason: ReplayReason; group: string } | null = null;

    for (const group of port.providerGroups(config.chainKey)) {
      const outcome = await port.fetchRange(config.chainKey, group, range);
      if (!outcome.ok) {
        failure = { reason: outcome.reason, group: outcome.providerGroup };
        break;
      }
      const classified = classifyObservation(outcome.observation);
      if (!classified.ok) {
        failure = { reason: classified.reason, group: classified.providerGroup };
        break;
      }
      results.push(classified.result);
    }

    if (failure === null) {
      const agreement = agree(results, config.agreement);
      if (agreement.kind === 'agreed') {
        return { kind: 'agreed', results: agreement.witnesses, digest: agreement.digest };
      }
      failure = { reason: agreement.reason, group: '' };
    }

    const step = nextStep({ range, attempts, retryBudget: config.retryBudget }, failure.reason);
    if (step.kind === 'retry') {
      attempts = step.attempts;
      continue;
    }
    if (step.kind === 'split') {
      return { kind: 'split', ranges: [...step.ranges] };
    }
    return {
      kind: 'blocked',
      reason: step.reason,
      group: failure.group === '' ? null : failure.group,
    };
  }
};

/**
 * Run one replay pass.
 *
 * Resumes from the stored checkpoint, so a crashed process re-enters exactly
 * where the last committed transaction left off and produces no duplicate facts:
 * every write is idempotent and the checkpoint only ever moves forward.
 */
export const runReplay = async (
  db: Db,
  port: LogSourcePort,
  config: ReplayConfig,
  hints: readonly PriorityHint[],
  now: Date,
): Promise<ReplayReport> => {
  const head = await port.agreedAcceptedHead(config.chainKey);
  const checkpoint = await readCheckpoint(db, config.deploymentId, config.chainKey);
  const checkpointBefore = checkpoint?.lastBlockNumber ?? null;

  // Resume: one block past the last committed checkpoint, or the manifest start.
  const resumeFrom =
    checkpointBefore === null
      ? config.startBlock
      : checkpointBefore + 1n > config.startBlock
        ? checkpointBefore + 1n
        : config.startBlock;

  const groups = port.providerGroups(config.chainKey);
  const width = groups.reduce(
    (min, g) => Math.min(min, port.maxRangeBlocks(config.chainKey, g)),
    Number.MAX_SAFE_INTEGER,
  );
  const plan: PlanInput = {
    startBlock: resumeFrom,
    agreedHead: head,
    maxRangeBlocks: width === Number.MAX_SAFE_INTEGER ? 1 : width,
    retryBudget: config.retryBudget,
  };

  // Hints only reorder. The queue is a permutation of the accepted-head plan.
  const queue = [...prioritise(planRanges(plan), hints.slice(0, config.maxHintsConsidered))];

  const reports: RangeReport[] = [];
  const reasons: ReplayReason[] = [];
  let integrityConflict = false;
  let lastSuccessAt: Date | null = null;

  while (queue.length > 0) {
    const range = queue.shift();
    if (!range) break;

    const collected = await collectRange(port, config, range);

    if (collected.kind === 'split') {
      // Smaller work, processed next. Coverage is unchanged.
      queue.unshift(...collected.ranges);
      continue;
    }

    if (collected.kind === 'blocked') {
      reasons.push(collected.reason);
      const meta = REASON_METADATA[collected.reason];
      const status: ReplayStatus =
        collected.reason === 'PROVIDER_DIVERGENCE' ? 'divergent' : 'blocked';

      await recordDataQualityIncident(db, {
        incidentId: incidentId(config.deploymentId, config.chainKey, range, collected.reason),
        deploymentId: config.deploymentId,
        chainKey: config.chainKey,
        reasonCode: collected.reason,
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        providerGroup: collected.group,
        runbook: meta.runbook,
        detail: { summary: meta.summary, span: spanOf(range).toString(10) },
      });
      await upsertRangeStatus(db, {
        rangeId: rangeId(config.deploymentId, config.chainKey, range),
        deploymentId: config.deploymentId,
        chainKey: config.chainKey,
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        status,
        reasonCode: collected.reason,
        providerGroup: collected.group,
      });

      reports.push({
        range,
        status,
        reason: collected.reason,
        providerGroups: [],
        digest: null,
      });
      // The checkpoint is NOT advanced, and the remaining ranges are abandoned
      // for this pass: committing later heights would leave this one as a hole
      // that the checkpoint has already skipped past.
      break;
    }

    const witness = collected.results[0];
    if (!witness) throw new Error('an agreed range must carry at least one witness');
    const provenance = provenanceOf(
      { kind: 'agreed', digest: collected.digest, witnesses: collected.results },
      config.agreement,
    );

    // Facts and the checkpoint that covers them, in ONE transaction. Every
    // witness agreed on the digest, so any of their fact sets is the same bytes;
    // taking the first is not a preference, it is an equality.
    try {
      await ingestBatch(db, {
        deploymentId: config.deploymentId,
        chainKey: config.chainKey,
        blocks: witness.blocks,
        logs: witness.logs,
        checkpoint: {
          deploymentId: config.deploymentId,
          chainKey: config.chainKey,
          lastBlockNumber: range.toBlock,
          lastBlockHash: witness.endBlockHash,
        },
      });
    } catch (e) {
      if (e instanceof AcceptedHashConflictError) {
        // Not a reorg, not repaired, not rolled back: evidence stays and the
        // answer becomes UNKNOWN until a human resolves it.
        integrityConflict = true;
        reasons.push('PROVIDER_DIVERGENCE');
        reports.push({ range, status: 'blocked', reason: null, providerGroups: [], digest: null });
        break;
      }
      throw e;
    }

    await upsertRangeStatus(db, {
      rangeId: rangeId(config.deploymentId, config.chainKey, range),
      deploymentId: config.deploymentId,
      chainKey: config.chainKey,
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
      status: 'complete',
      reasonCode: null,
      providerGroup: provenance.providerGroups.join(','),
    });

    lastSuccessAt = now;
    reports.push({
      range,
      status: 'complete',
      reason: null,
      providerGroups: provenance.providerGroups,
      digest: collected.digest,
    });
  }

  const committed = await readCommittedRanges(db, config.deploymentId, config.chainKey);
  const assessment = assessCompleteness({
    window: { fromBlock: config.startBlock, toBlock: head },
    committed,
    lastSuccessAt,
    freshnessTtlMs: config.freshnessTtlMs,
    openReasons: reasons,
    now,
  });

  await upsertCompleteness(db, {
    deploymentId: config.deploymentId,
    chainKey: config.chainKey,
    status: assessment.status,
    verdict: assessment.verdict,
    windowFrom: config.startBlock,
    windowTo: head,
    gapCount: assessment.gaps.length,
    reasons: assessment.reasons,
    lastSuccessAt,
    evaluatedAt: now,
  });

  const after = await readCheckpoint(db, config.deploymentId, config.chainKey);

  return {
    ranges: reports,
    acceptedHead: head,
    checkpointBefore,
    checkpointAfter: after?.lastBlockNumber ?? null,
    gapCount: assessment.gaps.length,
    status: assessment.status,
    verdict: assessment.verdict,
    reasons: assessment.reasons,
    integrityConflict,
  };
};

/** Persist discovered remotes as candidates. Never as approved members. */
export const persistRemoteCandidates = async (
  db: Db,
  deploymentId: string,
  candidates: readonly RemoteCandidate[],
): Promise<void> => {
  for (const c of candidates) {
    await recordRemoteCandidate(db, {
      deploymentId,
      remoteBlockchainId: c.remoteBlockchainId,
      remoteAddress: c.remoteAddress,
      registeredAtBlock: c.registeredAtBlock,
      registeredAtBlockHash: c.registeredAtBlockHash,
    });
  }
};
