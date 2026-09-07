import type { MessageAggregate } from './aggregate.js';
import { DESTINATION_EFFECT_KINDS, SOURCE_EFFECT_KINDS } from './inputs.js';
import { messageKeyOf } from './keys.js';

/**
 * Causally closed multi-chain watermark.
 *
 * The rule: if a destination execution is inside the cut, the source accounting
 * and send that caused it must be inside the cut too. Otherwise the evaluation
 * would compare a credit that exists against a debit that has not been observed
 * yet, and conclude a shortfall that is only a reading artefact.
 *
 * Closure is decided from causal edges and pinned block identities. Wall-clock
 * proximity is never used as a substitute: two chains being read "at about the
 * same time" says nothing about whether one's cause is inside the other's cut.
 */

export interface ChainCut {
  readonly blockchainId: string;
  readonly blockNumber: bigint;
  /** Both halves required. A height without a hash is not a pinned cut. */
  readonly blockHash: string;
}

export const CUT_OUTCOMES = ['closed', 'open', 'gap'] as const;
export type CutOutcome = (typeof CUT_OUTCOMES)[number];

export interface OpenEdge {
  readonly messageKey: string;
  /** The chain whose fact is still outside the cut. */
  readonly blockchainId: string;
  readonly reason: 'source-fact-outside-cut' | 'source-fact-not-observed';
}

export interface CutAssessment {
  readonly outcome: CutOutcome;
  /** Chains a fact referenced but no cut was pinned for. */
  readonly chainsWithoutCut: readonly string[];
  /** Causal edges that are not yet closed. */
  readonly openEdges: readonly OpenEdge[];
  /** Message keys fully inside the cut, canonically ordered. */
  readonly closedMessages: readonly string[];
}

const inCut = (
  position: { blockchainId: string; blockNumber: bigint },
  cuts: ReadonlyMap<string, ChainCut>,
): boolean | null => {
  const cut = cuts.get(position.blockchainId);
  if (!cut) return null;
  return position.blockNumber <= cut.blockNumber;
};

/**
 * Assess whether an evaluation cut is causally closed over these messages.
 *
 * `gap` means a chain has no pinned cut at all - the answer is unknown before
 * any causal reasoning starts. `open` means the cut exists but a cause sits
 * outside it. Neither is a failure of the bridge; both are reasons the
 * evaluation must return UNKNOWN rather than a number.
 */
export const assessCut = (
  aggregates: readonly MessageAggregate[],
  cuts: ReadonlyMap<string, ChainCut>,
): CutAssessment => {
  const chainsWithoutCut = new Set<string>();
  const openEdges: OpenEdge[] = [];
  const closedMessages: string[] = [];

  for (const aggregate of aggregates) {
    const key = messageKeyOf(aggregate.key);
    const facts = [...aggregate.facts.values()];

    for (const f of facts) {
      if (!cuts.has(f.position.blockchainId)) chainsWithoutCut.add(f.position.blockchainId);
    }

    // Only a destination effect that is already inside the cut creates an
    // obligation. A message nobody has executed yet imposes nothing.
    const destinationInCut = facts.filter(
      (f) => DESTINATION_EFFECT_KINDS.has(f.kind) && inCut(f.position, cuts) === true,
    );
    if (destinationInCut.length === 0) {
      continue;
    }

    const sourceFacts = facts.filter(
      (f) => SOURCE_EFFECT_KINDS.has(f.kind) || f.kind === 'icm-sent',
    );

    if (sourceFacts.length === 0) {
      // The credit is inside the cut and its cause has not been observed at all.
      openEdges.push({
        messageKey: key,
        blockchainId: aggregate.key.sourceBlockchainId,
        reason: 'source-fact-not-observed',
      });
      continue;
    }

    const outside = sourceFacts.filter((f) => inCut(f.position, cuts) !== true);
    if (outside.length > 0) {
      for (const f of outside) {
        openEdges.push({
          messageKey: key,
          blockchainId: f.position.blockchainId,
          reason: 'source-fact-outside-cut',
        });
      }
      continue;
    }

    closedMessages.push(key);
  }

  const outcome: CutOutcome =
    chainsWithoutCut.size > 0 ? 'gap' : openEdges.length > 0 ? 'open' : 'closed';

  return {
    outcome,
    chainsWithoutCut: [...chainsWithoutCut].sort(),
    openEdges: [...openEdges].sort((a, b) =>
      a.messageKey === b.messageKey
        ? a.blockchainId < b.blockchainId
          ? -1
          : 1
        : a.messageKey < b.messageKey
          ? -1
          : 1,
    ),
    closedMessages: [...closedMessages].sort(),
  };
};

/**
 * An evaluation may only produce a number when the cut is closed.
 *
 * `open` and `gap` both map to UNKNOWN. There is no "mostly closed" and no
 * partial-credit path: that is what fail-closed means here.
 */
export const cutPermitsEvaluation = (assessment: CutAssessment): boolean =>
  assessment.outcome === 'closed';
