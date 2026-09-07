import type { Db } from './client.js';

/**
 * Persistence for message transitions.
 *
 * The state machine stays pure; this is the only place its output touches a
 * database. Transitions are written a transaction at a time, because a terminal
 * state derived from half a transaction is not a fact (docs/milestones/08.md).
 */

export interface TransitionRow {
  readonly transitionId: string;
  readonly deploymentId: string;
  readonly sourceBlockchainId: string;
  readonly destinationBlockchainId: string;
  readonly messengerAddress: string;
  readonly registryProtocolVersion: number;
  readonly messageId: string;
  readonly transitionKind: string;
  /** The raw fact this rests on. Also the FK into chain_logs. */
  readonly chainKey: string;
  readonly blockHash: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly observedAt: Date;
  readonly envelopeId: string | null;
  readonly carriesEconomicEffect: boolean;
}

/** Raised when a route is about to be credited a second time. */
export class DuplicateEconomicEffectError extends Error {
  override readonly name = 'DuplicateEconomicEffectError';
  readonly messageId: string;
  constructor(messageId: string) {
    super(
      `message ${messageId} already has a credited economic effect on this route; ` +
        `a retry is another attempt, never another effect`,
    );
    this.messageId = messageId;
  }
}

const UNIQUE_VIOLATION = '23505';
const ONE_EFFECT_INDEX = 'message_transitions_one_economic_effect';

const isEffectConflict = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: string }).code === UNIQUE_VIOLATION &&
  ((e as { constraint_name?: string }).constraint_name === ONE_EFFECT_INDEX ||
    (e as { constraint?: string }).constraint === ONE_EFFECT_INDEX);

/**
 * Write a whole transaction's transitions atomically.
 *
 * All of them commit or none do. The economic-effect index is what turns "at
 * most one effect" from a rule the application remembers into one the database
 * enforces; a violation surfaces as a typed error rather than a second credit.
 */
export const writeTransitionBatch = async (
  db: Db,
  rows: readonly TransitionRow[],
): Promise<number> => {
  if (rows.length === 0) return 0;
  try {
    return await db.sql.begin(async (tx) => {
      let written = 0;
      for (const r of rows) {
        const inserted = await tx`
          insert into message_transitions
            (transition_id, deployment_id, source_blockchain_id, destination_blockchain_id,
             messenger_address, registry_protocol_version, message_id, transition_kind,
             chain_key, block_hash, tx_hash, log_index, observed_at,
             envelope_id, carries_economic_effect)
          values
            (${r.transitionId}, ${r.deploymentId}, ${r.sourceBlockchainId},
             ${r.destinationBlockchainId}, ${r.messengerAddress}, ${r.registryProtocolVersion},
             ${r.messageId}, ${r.transitionKind}, ${r.chainKey}, ${r.blockHash}, ${r.txHash},
             ${r.logIndex}, ${r.observedAt}, ${r.envelopeId}, ${r.carriesEconomicEffect})
          on conflict (source_blockchain_id, destination_blockchain_id, messenger_address,
                       registry_protocol_version, message_id, transition_kind,
                       chain_key, block_hash, tx_hash, log_index) do nothing
          returning transition_id
        `;
        written += inserted.length;
      }
      return written;
    });
  } catch (e) {
    if (isEffectConflict(e))
      throw new DuplicateEconomicEffectError(rows[0]?.messageId ?? 'unknown');
    throw e;
  }
};

/** Transitions for one route, canonically ordered by chain position. */
export const readTransitions = async (
  db: Db,
  route: {
    sourceBlockchainId: string;
    destinationBlockchainId: string;
    messengerAddress: string;
    registryProtocolVersion: number;
    messageId: string;
  },
): Promise<readonly { transitionKind: string; carriesEconomicEffect: boolean }[]> => {
  const rows = await db.sql<{ transition_kind: string; carries_economic_effect: boolean }[]>`
    select transition_kind, carries_economic_effect
    from message_transitions
    where source_blockchain_id = ${route.sourceBlockchainId}
      and destination_blockchain_id = ${route.destinationBlockchainId}
      and messenger_address = ${route.messengerAddress}
      and registry_protocol_version = ${route.registryProtocolVersion}
      and message_id = ${route.messageId}
    order by transition_kind
  `;
  return rows.map((r) => ({
    transitionKind: r.transition_kind,
    carriesEconomicEffect: r.carries_economic_effect,
  }));
};

/** Count credited effects on a route. Must never exceed one. */
export const countEconomicEffects = async (db: Db, messageId: string): Promise<number> => {
  const rows = await db.sql<{ n: string }[]>`
    select count(*)::text as n from message_transitions
    where message_id = ${messageId} and carries_economic_effect
  `;
  return Number(rows[0]?.n ?? '0');
};
